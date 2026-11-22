import Anthropic from "@anthropic-ai/sdk";

/**
 * The prompt version stamped onto every review. Later tickets store it beside
 * each finding so a prompt change never poisons old training data. Bump this
 * whenever the wording or schema below changes.
 */
export const PROMPT_VERSION = "2026-07-21.1";

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
}

/** The full text of one changed file at the pull request's head. */
export interface ReviewFile {
  path: string;
  contents: string;
}

/** Everything the model needs to review one pull request. */
export interface ReviewRequest {
  /** Unified diff of the whole pull request. */
  diff: string;
  /** Full current text of every changed file we chose to include. */
  files: ReviewFile[];
  /** Carried through so the real client can stamp the prompt it used. */
  promptVersion: string;
}

/** What the review call produced. */
export interface ReviewResponse {
  /** Every finding the model returned — unfiltered; the gate runs later. */
  findings: Finding[];
  /** Which model actually produced these (default or fallback). */
  model: string;
}

/**
 * The narrow slice of Claude the review engine needs. Real code wraps the
 * Anthropic SDK; tests supply a fake that returns canned structured findings,
 * so no test touches the network. Injected the same way as the GitHub client.
 */
export interface ReviewModel {
  review(request: ReviewRequest): Promise<ReviewResponse>;
}

/**
 * The system prompt. It tells the model to report EVERY finding with a severity
 * and a confidence and never to self-suppress — the severity gate lives in our
 * code, not here, so we can still capture sub-threshold findings for the store.
 * It also gives explicit permission to return an empty array on a clean change.
 */
const SYSTEM_PROMPT = [
  "You are a code reviewer for pull requests. You look for correctness problems",
  "first: logic errors, unhandled errors and nulls, race conditions, off-by-one",
  "mistakes, misused APIs, and code that breaks under some input. You may also",
  "note widely-accepted language idioms for React, TypeScript, and Python.",
  "",
  "Do NOT comment on security, PHI, or PII — a separate review owns those — and",
  "do not flag pure style a formatter already handles.",
  "",
  "Report EVERY finding you see. For each one give a severity (low, medium,",
  "high, or critical) and a confidence from 0 to 1. Do NOT decide for yourself",
  "that a finding is too minor to mention and drop it — a later step filters by",
  "severity and confidence. Your job here is coverage, not filtering.",
  "",
  "If the change is clean, return an empty findings array. That is a valid and",
  "welcome result — an empty array means 'looks good', not a mistake.",
  "",
  "Anchor every finding to the file and line it applies to.",
].join("\n");

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

/** Assemble the user turn: the diff followed by each full file. */
function buildUserContent(request: ReviewRequest): string {
  const parts = [
    "Review this pull request. Here is the unified diff:",
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
  return parts.join("\n");
}

async function callModel(
  anthropic: Anthropic,
  model: string,
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
    system: SYSTEM_PROMPT,
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
 * Build a {@link ReviewModel} backed by the Anthropic SDK. It sends the diff
 * and full files to the primary model and validates the structured findings it
 * returns. If the primary model call fails, it retries once on the fallback
 * model — so we can drop to a cheaper model later without a rewrite.
 */
export function createAnthropicModel(
  anthropic: Anthropic,
  options: ReviewModelOptions = {},
): ReviewModel {
  const model = options.model ?? DEFAULT_MODEL;
  const fallbackModel = options.fallbackModel ?? DEFAULT_FALLBACK_MODEL;

  return {
    async review(request) {
      const userContent = buildUserContent(request);
      try {
        return { findings: await callModel(anthropic, model, userContent), model };
      } catch {
        // The primary model was unavailable or errored — try the fallback once.
        // If that also fails, the error propagates to the caller.
        return {
          findings: await callModel(anthropic, fallbackModel, userContent),
          model: fallbackModel,
        };
      }
    },
  };
}
