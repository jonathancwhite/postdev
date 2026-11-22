import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type {
  GitHubClient,
  InstallationOctokit,
  PullRequestContext,
} from "../src/github/client.js";
import {
  createReviewContextReader,
  findIssueReferences,
  MAX_SPEC_ISSUES,
  type ReviewContextReader,
} from "../src/github/reviewContext.js";
import {
  createAnthropicModel,
  type Finding,
  type ReviewModel,
  type ReviewRequest,
} from "../src/model/reviewModel.js";
import {
  CORRECTNESS_SYSTEM_PROMPT,
  SMELL_BASELINE,
  SPEC_INCREMENTAL_NOTE,
  SPEC_SYSTEM_PROMPT,
  STANDARDS_SYSTEM_PROMPT,
} from "../src/model/reviewPrompts.js";
import { postReview } from "../src/review/postReview.js";
import {
  reviewPullRequest,
  type GatedFinding,
  type ReviewResult,
} from "../src/review/reviewPullRequest.js";

const PR: PullRequestContext = {
  owner: "jonathancwhite",
  repo: "widgets",
  pullNumber: 42,
  isDraft: false,
  headSha: "head123",
};

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "x.ts",
    line: 10,
    severity: "medium",
    category: "possible Feature Envy",
    message: "total() reads only cart fields.",
    confidence: 0.7,
    ...overrides,
  };
}

/** A fake Anthropic client: records each call and answers by system prompt. */
function fakeAnthropic(
  answer: (system: string) => Finding[] | Error,
): { client: Anthropic; calls: Array<{ model: string; system: string; user: string }> } {
  const calls: Array<{ model: string; system: string; user: string }> = [];
  const client = {
    messages: {
      async create(params: {
        model: string;
        system: string;
        messages: Array<{ content: string }>;
      }) {
        calls.push({
          model: params.model,
          system: params.system,
          user: params.messages[0]!.content,
        });
        const result = answer(params.system);
        if (result instanceof Error) throw result;
        return {
          content: [{ type: "text", text: JSON.stringify({ findings: result }) }],
        };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    diff: "diff --git a/x.ts b/x.ts",
    files: [{ path: "x.ts", contents: "const x = 1;" }],
    promptVersion: "test",
    ...overrides,
  };
}

describe("findIssueReferences", () => {
  it("finds bare, closing, cross-reference and link forms for this repo only", () => {
    const refs = findIssueReferences(
      [
        "Closes #12 and fixes #7",
        "See jonathancwhite/widgets#9 and other/repo#99",
        "Spec: https://github.com/jonathancwhite/widgets/issues/30",
        "Elsewhere: https://github.com/other/repo/issues/31",
      ],
      "jonathancwhite",
      "widgets",
      42,
    );
    expect(refs).toEqual([12, 7, 9, 30]);
  });

  it("skips the pull request's own number, HTML entities and duplicates", () => {
    expect(
      findIssueReferences(["#42 &#123; #5 #5 color#3"], "o", "r", 42),
    ).toEqual([5]);
  });
});

describe("createReviewContextReader", () => {
  /** A fake Octokit `request` that serves canned answers by route. */
  function fakeOctokit(routes: Record<string, (params: Record<string, unknown>) => unknown>) {
    const seen: Array<{ route: string; params: Record<string, unknown> }> = [];
    const octokit = {
      async request(route: string, params: Record<string, unknown>) {
        seen.push({ route, params });
        const handler = routes[route];
        if (!handler) throw new Error(`unexpected ${route}`);
        return { data: handler(params) };
      },
    } as unknown as InstallationOctokit;
    return { octokit, seen };
  }

  it("reads standards files at the pull request's base and skips missing ones", async () => {
    const { octokit, seen } = fakeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({ base: { sha: "base999" } }),
      "GET /repos/{owner}/{repo}/contents/{path}": (params) => {
        if (params.path === "CONTRIBUTING.md") return "Use named exports.";
        if (params.path === "CLAUDE.md") return "Prefer small modules.";
        throw new Error("Not Found");
      },
    });
    const docs = await createReviewContextReader(octokit).standards(PR);
    expect(docs).toEqual([
      { source: "CONTRIBUTING.md", text: "Use named exports." },
      { source: "CLAUDE.md", text: "Prefer small modules." },
    ]);
    const refs = seen
      .filter((call) => call.route.includes("/contents/"))
      .map((call) => call.params.ref);
    expect(new Set(refs)).toEqual(new Set(["base999"]));
  });

  it("reads linked issues as the spec, skipping pull requests and capping the count", async () => {
    const { octokit } = fakeOctokit({
      "GET /repos/{owner}/{repo}/pulls/{pull_number}": () => ({
        title: "Add totals (#1)",
        body: "Closes #2. Also see #3, #4 and #5.",
      }),
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits": () => [
        { commit: { message: "Fix #6" } },
      ],
      "GET /repos/{owner}/{repo}/issues/{issue_number}": (params) => {
        const n = params.issue_number as number;
        if (n === 2) return { title: "Old PR", body: "", pull_request: {} };
        return { title: `Issue ${n}`, body: `Do thing ${n}.` };
      },
    });
    const docs = await createReviewContextReader(octokit).spec(PR);
    expect(docs).toHaveLength(MAX_SPEC_ISSUES);
    expect(docs.map((doc) => doc.source)).toEqual(["issue #1", "issue #3", "issue #4"]);
    expect(docs[0]!.text).toBe("# Issue 1\n\nDo thing 1.");
  });
});

describe("createAnthropicModel, separate axes", () => {
  it("runs Correctness, Standards and Spec as separate calls and labels each finding by axis", async () => {
    const { client, calls } = fakeAnthropic((system) => {
      if (system === SPEC_SYSTEM_PROMPT) {
        return [finding({ category: "missing requirement", severity: "high" })];
      }
      if (system === CORRECTNESS_SYSTEM_PROMPT) {
        return [finding({ category: "unhandled null", severity: "high" })];
      }
      return [finding()];
    });
    const model = createAnthropicModel(client, { model: "primary", fallbackModel: "fallback" });
    const response = await model.review(
      request({
        standards: [{ source: "CONTRIBUTING.md", text: "Use named exports." }],
        spec: [{ source: "issue #7", text: "# Totals\n\nShow a cart total." }],
      }),
    );

    expect(calls.map((call) => call.system).sort()).toEqual(
      [CORRECTNESS_SYSTEM_PROMPT, SPEC_SYSTEM_PROMPT, STANDARDS_SYSTEM_PROMPT].sort(),
    );
    const correctnessCall = calls.find((call) => call.system === CORRECTNESS_SYSTEM_PROMPT)!;
    expect(correctnessCall.user).toContain("const x = 1;");
    expect(correctnessCall.user).not.toContain("Use named exports");
    expect(correctnessCall.user).not.toContain("Show a cart total");
    const standardsCall = calls.find((call) => call.system === STANDARDS_SYSTEM_PROMPT)!;
    const specCall = calls.find((call) => call.system === SPEC_SYSTEM_PROMPT)!;
    expect(standardsCall.user).toContain('<repo-document source="CONTRIBUTING.md">');
    expect(standardsCall.user).not.toContain("Show a cart total");
    expect(specCall.user).toContain('<issue source="issue #7">');
    expect(specCall.user).not.toContain("Use named exports");

    expect(response.specReviewed).toBe(true);
    expect(response.model).toBe("primary");
    expect(response.findings.map((f) => [f.axis, f.category])).toEqual([
      ["correctness", "unhandled null"],
      ["standards", "possible Feature Envy"],
      ["spec", "missing requirement"],
    ]);
  });

  it("carries the smell baseline in the Standards prompt", () => {
    expect(STANDARDS_SYSTEM_PROMPT).toContain(SMELL_BASELINE);
    expect(SMELL_BASELINE.split("\n")).toHaveLength(12);
  });

  it("skips Spec when the pull request links no issue", async () => {
    const { client, calls } = fakeAnthropic(() => []);
    const response = await createAnthropicModel(client).review(request());
    expect(calls.map((call) => call.system).sort()).toEqual(
      [CORRECTNESS_SYSTEM_PROMPT, STANDARDS_SYSTEM_PROMPT].sort(),
    );
    const standardsCall = calls.find((call) => call.system === STANDARDS_SYSTEM_PROMPT)!;
    expect(standardsCall.user).toContain("no documented coding standards");
    expect(response.specReviewed).toBe(false);
  });

  it("tells Spec not to judge missing requirements on an incremental pass", async () => {
    const { client, calls } = fakeAnthropic(() => []);
    await createAnthropicModel(client).review(
      request({ spec: [{ source: "issue #7", text: "x" }], incremental: true }),
    );
    const specCall = calls.find((call) => call.system === SPEC_SYSTEM_PROMPT)!;
    expect(specCall.user).toContain(SPEC_INCREMENTAL_NOTE);
  });

  it("falls back per axis and reports the fallback model", async () => {
    const { client, calls } = fakeAnthropic(() => []);
    const flaky = {
      messages: {
        async create(params: { model: string; system: string }) {
          if (params.model === "primary" && params.system === SPEC_SYSTEM_PROMPT) {
            throw new Error("overloaded");
          }
          return (client.messages.create as unknown as (p: unknown) => unknown)(params);
        },
      },
    } as unknown as Anthropic;
    const response = await createAnthropicModel(flaky, {
      model: "primary",
      fallbackModel: "fallback",
    }).review(request({ spec: [{ source: "issue #7", text: "x" }] }));
    expect(response.model).toBe("fallback");
    expect(calls.map((call) => [call.model, call.system === SPEC_SYSTEM_PROMPT])).toContainEqual([
      "fallback",
      true,
    ]);
  });
});

describe("reviewPullRequest with review context", () => {
  const github = {
    async getPullRequestDiff() {
      return "diff --git a/x.ts b/x.ts";
    },
    async listChangedFiles() {
      return [{ filename: "x.ts", status: "modified", additions: 1, deletions: 0, changes: 1 }];
    },
    async getFileContents() {
      return "const x = 1;";
    },
  } as unknown as GitHubClient;

  function recordingModel(): { claude: ReviewModel; requests: ReviewRequest[] } {
    const requests: ReviewRequest[] = [];
    return {
      requests,
      claude: {
        async review(req) {
          requests.push(req);
          return { findings: [], model: "m", specReviewed: (req.spec ?? []).length > 0 };
        },
      },
    };
  }

  it("passes the standards and linked issues to the model", async () => {
    const { claude, requests } = recordingModel();
    const context: ReviewContextReader = {
      async standards() {
        return [{ source: "CLAUDE.md", text: "rules" }];
      },
      async spec() {
        return [{ source: "issue #3", text: "spec" }];
      },
    };
    const result = await reviewPullRequest(PR, { github, claude, context });
    expect(requests[0]!.standards).toEqual([{ source: "CLAUDE.md", text: "rules" }]);
    expect(requests[0]!.spec).toEqual([{ source: "issue #3", text: "spec" }]);
    expect(requests[0]!.incremental).toBe(false);
    expect(result.specReviewed).toBe(true);
  });

  it("still reviews when reading the context fails", async () => {
    const { claude, requests } = recordingModel();
    const context: ReviewContextReader = {
      async standards() {
        throw new Error("rate limited");
      },
      async spec() {
        throw new Error("rate limited");
      },
    };
    const result = await reviewPullRequest(PR, { github, claude, context });
    expect(requests[0]!.standards).toEqual([]);
    expect(requests[0]!.spec).toEqual([]);
    expect(result.specReviewed).toBe(false);
  });
});

describe("postReview, separate axes", () => {
  const DIFF = [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -9,2 +9,4 @@",
    " const before = 1;",
    "+const a = 1;",
    "+const b = 2;",
    " const after = 3;",
  ].join("\n");

  function fakeGitHub(): { client: GitHubClient; bodies: string[]; inline: string[] } {
    const bodies: string[] = [];
    const inline: string[] = [];
    const client = {
      async createReview(params: { body: string; comments: Array<{ body: string }> }) {
        bodies.push(params.body);
        inline.push(...params.comments.map((comment) => comment.body));
        return { reviewId: 1, comments: [] };
      },
      async getPullRequestDiff() {
        return DIFF;
      },
    } as unknown as GitHubClient;
    return { client, bodies, inline };
  }

  function gated(overrides: Partial<Finding>): GatedFinding {
    return { ...finding(overrides), shouldPost: true };
  }

  function result(overrides: Partial<ReviewResult>): ReviewResult {
    return { findings: [], partial: false, model: "m", promptVersion: "t", ...overrides };
  }

  it("labels each comment with its axis and reports the axes in separate sections", async () => {
    const github = fakeGitHub();
    await postReview(
      PR,
      result({
        specReviewed: true,
        findings: [
          gated({ axis: "spec", category: "scope creep", line: 11, message: "Adds a CSV export the issue never asked for." }),
          gated({ axis: "standards", category: "possible Feature Envy", line: 10 }),
          gated({ axis: "correctness", category: "unhandled null", line: 10, severity: "high", message: "b is null when the cart is empty." }),
        ],
      }),
      { github: github.client },
    );
    expect(github.inline.some((body) => body.includes("**[MEDIUM] Spec · scope creep**"))).toBe(true);
    expect(github.inline.some((body) => body.includes("**[MEDIUM] Standards · possible Feature Envy**"))).toBe(true);
    expect(github.inline.some((body) => body.includes("**[HIGH] Correctness · unhandled null**"))).toBe(true);
    const body = github.bodies[0]!;
    expect(body.indexOf("**Correctness**")).toBeGreaterThan(-1);
    expect(body.indexOf("**Standards**")).toBeGreaterThan(body.indexOf("**Correctness**"));
    expect(body.indexOf("**Spec**")).toBeGreaterThan(body.indexOf("**Standards**"));
    expect(body).not.toContain("Spec: skipped");
  });

  it("says when Spec was skipped for want of a linked issue", async () => {
    const github = fakeGitHub();
    await postReview(PR, result({ specReviewed: false }), { github: github.client });
    expect(github.bodies[0]).toContain("Looks good");
    expect(github.bodies[0]).toContain("Spec: skipped, because this pull request links no issue");
  });
});
