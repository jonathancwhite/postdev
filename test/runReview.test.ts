import { describe, expect, it } from "vitest";
import type {
  ChangedFile,
  GitHubClient,
  PullRequestContext,
} from "../src/github/client.js";
import type {
  ReviewModel,
  Finding,
  ReviewRequest,
} from "../src/model/reviewModel.js";
import { PROMPT_VERSION } from "../src/model/reviewModel.js";
import { runReview } from "../src/review/runReview.js";
import { createFakeTrainingStore } from "./helpers/fakeTrainingStore.js";

// A diff that adds lines 10 and 11 to x.ts, so those two lines are postable.
const DIFF_X_10_11 = [
  "diff --git a/x.ts b/x.ts",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -9,2 +9,4 @@",
  " const before = 1;",
  "+const a = 1;",
  "+const b = 2;",
  " const after = 3;",
].join("\n");

function changed(filename: string): ChangedFile {
  return { filename, status: "modified", additions: 1, deletions: 0, changes: 1 };
}

/** A fake GitHub client: canned diff/files, and createReview handing back ids. */
function fakeGitHub(diff: string): GitHubClient {
  return {
    async postIssueComment() {},
    async createReview(params) {
      return {
        reviewId: 5000,
        comments: params.comments.map((comment, index) => ({
          path: comment.path,
          line: comment.line,
          id: 6000 + index,
        })),
      };
    },
    async getPullRequestDiff() {
      return diff;
    },
    async listChangedFiles() {
      return [changed("x.ts")];
    },
    async getFileContents() {
      return "const before = 1;\nconst a = 1;\nconst b = 2;\nconst after = 3;\n";
    },
  };
}

/** A fake Claude client returning canned raw findings; the gate runs downstream. */
function fakeClaude(findings: Finding[], model = "claude-opus-4-8"): ReviewModel {
  const requests: ReviewRequest[] = [];
  return {
    async review(request) {
      requests.push(request);
      return { findings, model };
    },
  };
}

function prContext(
  overrides: Partial<PullRequestContext> = {},
): PullRequestContext {
  return {
    owner: "constant-eng",
    repo: "widgets",
    pullNumber: 42,
    isDraft: false,
    headSha: "abc123",
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "x.ts",
    line: 10,
    severity: "high",
    category: "correctness",
    message: "This throws when x is null",
    confidence: 0.9,
    ...overrides,
  };
}

describe("runReview persistence", () => {
  it("records one review row with the model and prompt version stamped", async () => {
    const { store, records } = createFakeTrainingStore();

    await runReview(prContext(), {
      github: fakeGitHub(DIFF_X_10_11),
      claude: fakeClaude([finding({ line: 10 })], "claude-sonnet-5"),
      store,
    });

    expect(records).toHaveLength(1);
    const review = records[0]!;
    expect(review.owner).toBe("constant-eng");
    expect(review.repo).toBe("widgets");
    expect(review.pullNumber).toBe(42);
    expect(review.headSha).toBe("abc123");
    expect(review.modelId).toBe("claude-sonnet-5");
    expect(review.promptVersion).toBe(PROMPT_VERSION);
    expect(review.githubReviewId).toBe(5000);
  });

  it("writes a row for every finding, sub-threshold ones marked not-posted", async () => {
    const { store, records } = createFakeTrainingStore();

    await runReview(prContext(), {
      github: fakeGitHub(DIFF_X_10_11),
      claude: fakeClaude([
        finding({ line: 10, severity: "high", message: "real bug" }),
        finding({ line: 10, severity: "low", message: "tiny nit" }),
        finding({ line: 99, severity: "high", message: "outside the diff" }),
      ]),
      store,
    });

    const { findings } = records[0]!;
    expect(findings).toHaveLength(3);

    const inline = findings.find((f) => f.finding.message === "real bug")!;
    const subThreshold = findings.find((f) => f.finding.message === "tiny nit")!;
    const unanchored = findings.find(
      (f) => f.finding.message === "outside the diff",
    )!;

    // The high finding on a postable line posts inline, with its comment id and
    // the diff hunk it sits in.
    expect(inline.placement).toBe("inline");
    expect(inline.shouldPost).toBe(true);
    expect(inline.githubCommentId).toBe(6000);
    expect(inline.diffHunk).toContain("@@ -9,2 +9,4 @@");

    // The low finding stays below the gate: kept, but not posted.
    expect(subThreshold.placement).toBe("not-posted");
    expect(subThreshold.shouldPost).toBe(false);
    expect(subThreshold.githubCommentId).toBeNull();

    // The high finding off the diff folds into the summary — never dropped.
    expect(unanchored.placement).toBe("summary");
    expect(unanchored.shouldPost).toBe(true);
    expect(unanchored.githubCommentId).toBeNull();
    expect(unanchored.diffHunk).toBeNull();
  });

  it("keeps the whole structured finding and stamps each row for append-only storage", async () => {
    const { store, records } = createFakeTrainingStore();

    await runReview(prContext(), {
      github: fakeGitHub(DIFF_X_10_11),
      claude: fakeClaude([finding({ line: 10 })]),
      store,
    });

    const row = records[0]!.findings[0]!;
    // The full finding is kept, not flattened away.
    expect(row.finding.file).toBe("x.ts");
    expect(row.finding.confidence).toBe(0.9);
    expect(row.finding.category).toBe("correctness");
    // Each row carries its own model and prompt-version stamp.
    expect(row.modelId).toBe("claude-opus-4-8");
    expect(row.promptVersion).toBe(PROMPT_VERSION);
    // A stable fingerprint is recorded for dedupe (ticket 05).
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives the same finding the same fingerprint across pull requests", async () => {
    const first = createFakeTrainingStore();
    const second = createFakeTrainingStore();

    await runReview(prContext({ pullNumber: 1 }), {
      github: fakeGitHub(DIFF_X_10_11),
      claude: fakeClaude([finding({ line: 10 })]),
      store: first.store,
    });
    // Same finding content, different pull request and line — the fingerprint
    // ignores the line, so dedupe still recognises it.
    await runReview(prContext({ pullNumber: 2 }), {
      github: fakeGitHub(DIFF_X_10_11),
      claude: fakeClaude([finding({ line: 11 })]),
      store: second.store,
    });

    expect(first.records[0]!.findings[0]!.fingerprint).toBe(
      second.records[0]!.findings[0]!.fingerprint,
    );
  });

  it("still reviews and posts when no store is injected", async () => {
    // No store — the flow must run to completion and simply record nothing.
    await expect(
      runReview(prContext(), {
        github: fakeGitHub(DIFF_X_10_11),
        claude: fakeClaude([finding({ line: 10 })]),
      }),
    ).resolves.toBeUndefined();
  });
});
