import Anthropic from "@anthropic-ai/sdk";
import {
  CORRECTNESS_SYSTEM_PROMPT,
  SPEC_INCREMENTAL_NOTE,
  SPEC_SYSTEM_PROMPT,
  STANDARDS_SYSTEM_PROMPT,
} from "./reviewPrompts.js";

/**
 * The prompt version stamped onto every review. Later tickets store it beside
 * each finding so a prompt change never poisons old training data. Bump this
 * whenever the wording or schema below changes.
 */
export const PROMPT_VERSION = "2026-11-22.1";

/** The engine's default review model. A host may override it — the GitHub
 * Action defaults to a cheaper model so a personal repo's bill stays small. */
export const DEFAULT_MODEL = "claude-opus-5-5";

/** Configurable fallback, tried when the default model is unavailable. */
export const DEFAULT_FALLBACK_MODEL = "claude-sonnet-5-5";

/**
 * How bad a finding is. Ranked low → critical; the severity gate in the review
 * engine decides which of these get posted (see reviewPullRequest).
 */
export type Severity = "low" | "medium" | "high" | "critical";

const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];

/**
 * Which review a finding came from. Correctness asks whether the changed code
 * works; Standards asks whether it follows the repository's documented coding
 * standards (plus a code-smell baseline); Spec asks whether it does what its
 * linked issue asked. Each is reviewed and reported separately, never ranked
 * against the others.
 */
export type ReviewAxis = "correctness" | "standards" | "spec";

/** The axes in the order they are reported. */
export const REVIEW_AXES: readonly ReviewAxis[] = ["correctness", "standards", "spec"];

/** A single thing the model flagged. The model reports every one it finds. */
export interface Finding {
  /** Path of the changed file the finding sits in. */
  file: string;
  /** 1-based line in that file the finding anchors to. */
  line: number;
  severity: Severity;
  /** Short kind of problem, e.g. "correctness", "unhandled-error", "idiom". */
  category: string;
  /** Plain-language description of the problem. */
  message: string;
  /** The model's own confidence, 0..1. */
  confidence: number;
  /** The review that produced it. Absent on findings from older prompts. */
  axis?: ReviewAxis;
}

/** The full text of one changed file at the pull request's head. */
export interface ReviewFile {
  path: string;
  contents: string;
}

/** A document the review measures the change against, with where it came from. */
export interface ReviewDocument {
  /** Where it came from, e.g. "CONTRIBUTING.md" or "issue #42". */
  source: string;
  text: string;
}

/** Everything the model needs to review one pull request. */
export interface ReviewRequest {
  /** Unified diff of the whole pull request. */
  diff: string;
  /** Full current text of every changed file we chose to include. */
  files: ReviewFile[];
  /** Carried through so the real client can stamp the prompt it used. */
  promptVersion: string;
  /** The repository's documents on how code should be written (Standards). */
  standards?: ReviewDocument[];
  /** The issues the pull request links to (Spec). None means Spec is skipped. */
  spec?: ReviewDocument[];
  /** True when the diff is only the newest push, not the whole pull request. */
  incremental?: boolean;
}

/** What the review call produced. */
export interface ReviewResponse {
  /** Every finding the model returned — unfiltered; the gate runs later. */
  findings: Finding[];
  /** Which model actually produced these (default or fallback). */
  model: string;
  /** True when the Spec review ran; false when there was no linked issue. */
  specReviewed?: boolean;
}

/**
 * The narrow slice of Claude the review engine needs. Real code wraps the
 * Anthropic SDK; tests supply a fake that returns canned structured findings,
 * so no test touches the network. Injected the same way as the GitHub client.
 */
export interface ReviewModel {
  review(request: ReviewRequest): Promise<ReviewResponse>;
}

/** JSON Schema the structured-output call validates the model against. */
const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          severity: { type: "string", enum: SEVERITIES },
          category: { type: "string" },
          message: { type: "string" },
          confidence: { type: "number" },
        },
        required: [
          "file",
          "line",
          "severity",
          "category",
          "message",
          "confidence",
        ],
      },
    },
  },
  required: ["findings"],
} as const;

function isSeverity(value: unknown): value is Severity {
  return (
    typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)
  );
}

/**
 * Validate one raw finding from the model into a {@link Finding}, or throw if it
 * is the wrong shape. The structured-output call already constrains the model,
 * but we re-check here so a malformed response can never flow downstream.
 */
function parseFinding(raw: unknown): Finding {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Finding is not an object");
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.file !== "string") throw new Error("Finding.file must be a string");
  if (typeof f.line !== "number") throw new Error("Finding.line must be a number");
  if (!isSeverity(f.severity)) throw new Error("Finding.severity is invalid");
  if (typeof f.category !== "string") {
    throw new Error("Finding.category must be a string");
  }
  if (typeof f.message !== "string") {
    throw new Error("Finding.message must be a string");
  }
  if (typeof f.confidence !== "number") {
    throw new Error("Finding.confidence must be a number");
  }
  return {
    file: f.file,
    line: f.line,
    severity: f.severity,
    category: f.category,
    message: f.message,
    confidence: f.confidence,
  };
}

/** Turn a raw model response body into a validated array of findings. */
export function parseFindings(text: string): Finding[] {
  const data: unknown = JSON.parse(text);
  if (typeof data !== "object" || data === null || !("findings" in data)) {
    throw new Error("Response has no findings array");
  }
  const findings = (data as { findings: unknown }).findings;
  if (!Array.isArray(findings)) {
    throw new Error("Response findings is not an array");
  }
  return findings.map(parseFinding);
}

/** Wrap untrusted documents in tags the prompts tell the model are data. */
function documentBlock(tag: string, docs: ReviewDocument[]): string[] {
  return docs.flatMap((doc) => [
    `<${tag} source=${JSON.stringify(doc.source)}>`,
    doc.text,
    `</${tag}>`,
    "",
  ]);
}

/** The diff and the full text of each changed file, shared by both axes. */
function changeContent(request: ReviewRequest): string[] {
  const parts = [
    "Here is the unified diff of the change:",
    "",
    "```diff",
    request.diff,
    "```",
    "",
  ];
  if (request.files.length > 0) {
    parts.push("Full current text of the changed files:", "");
    for (const file of request.files) {
      parts.push(`### ${file.path}`, "```", file.contents, "```", "");
    }
  }
  return parts;
}

/** The user turn for the Correctness axis: the change alone. */
export function buildCorrectnessContent(request: ReviewRequest): string {
  return changeContent(request).join("\n");
}

/** The user turn for the Standards axis: the repo's standards, then the change. */
export function buildStandardsContent(request: ReviewRequest): string {
  const standards = request.standards ?? [];
  const parts =
    standards.length > 0
      ? [
          "The repository documents how code should be written in these files:",
          "",
          ...documentBlock("repo-document", standards),
        ]
      : [
          "The repository has no documented coding standards, so review against the smell baseline only.",
          "",
        ];
  return [...parts, ...changeContent(request)].join("\n");
}

/** The user turn for the Spec axis: the linked issues, then the change. */
export function buildSpecContent(request: ReviewRequest): string {
  const parts = [
    "The pull request links to these issues, which are its spec:",
    "",
    ...documentBlock("issue", request.spec ?? []),
  ];
  if (request.incremental) parts.push(SPEC_INCREMENTAL_NOTE, "");
  return [...parts, ...changeContent(request)].join("\n");
}

async function callModel(
  anthropic: Anthropic,
  model: string,
  system: string,
  userContent: string,
): Promise<Finding[]> {
  const response = await anthropic.messages.create({
    model,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "high",
      format: {
        type: "json_schema",
        schema: OUTPUT_SCHEMA,
      },
    },
    system,
    messages: [{ role: "user", content: userContent }],
  });

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  return parseFindings(text);
}

export interface ReviewModelOptions {
  /** Primary review model. Defaults to Opus 5.5. */
  model?: string;
  /** Fallback model, tried once if the primary call fails. Defaults to Sonnet 5.5. */
  fallbackModel?: string;
}

/**
 * Build a {@link ReviewModel} backed by the Anthropic SDK. It reviews the change
 * on separate axes, each its own model call with its own prompt: Correctness
 * and Standards always, and Spec only when the pull request links an issue.
 * They run in parallel and their findings come back labelled by axis, never
 * reranked. Each call that fails on the primary model is retried once on the
 * fallback model.
 */
export function createAnthropicModel(
  anthropic: Anthropic,
  options: ReviewModelOptions = {},
): ReviewModel {
  const model = options.model ?? DEFAULT_MODEL;
  const fallbackModel = options.fallbackModel ?? DEFAULT_FALLBACK_MODEL;

  /** One axis's call, falling back once; returns the model that answered. */
  async function reviewAxis(
    axis: ReviewAxis,
    system: string,
    userContent: string,
  ): Promise<{ findings: Finding[]; model: string }> {
    let findings: Finding[];
    let used = model;
    try {
      findings = await callModel(anthropic, model, system, userContent);
    } catch {
      // The primary model was unavailable or errored: try the fallback once.
      // If that also fails, the error propagates to the caller.
      used = fallbackModel;
      findings = await callModel(anthropic, fallbackModel, system, userContent);
    }
    return { findings: findings.map((f) => ({ ...f, axis })), model: used };
  }

  return {
    async review(request) {
      const specReviewed = (request.spec ?? []).length > 0;
      const [correctness, standards, spec] = await Promise.all([
        reviewAxis("correctness", CORRECTNESS_SYSTEM_PROMPT, buildCorrectnessContent(request)),
        reviewAxis("standards", STANDARDS_SYSTEM_PROMPT, buildStandardsContent(request)),
        specReviewed
          ? reviewAxis("spec", SPEC_SYSTEM_PROMPT, buildSpecContent(request))
          : Promise.resolve(null),
      ]);
      // If any axis needed the fallback, report the fallback: the stored model
      // id should never overstate which model reviewed the change.
      const ran = [correctness, standards, ...(spec ? [spec] : [])];
      const usedModel = ran.some((axis) => axis.model === fallbackModel)
        ? fallbackModel
        : model;
      return {
        findings: ran.flatMap((axis) => axis.findings),
        model: usedModel,
        specReviewed,
      };
    },
  };
}
