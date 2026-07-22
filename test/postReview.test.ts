import { describe, expect, it } from "vitest";
import type { GitHubClient, PullRequestContext } from "../src/github/client.js";
import type { Finding } from "../src/model/reviewModel.js";
import type {
  GatedFinding,
  ReviewResult,
} from "../src/review/reviewPullRequest.js";
import { SEVERITY_THRESHOLD } from "../src/review/reviewPullRequest.js";
import { postReview } from "../src/review/postReview.js";

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 } as const;

interface CreatedReview {
  owner: string;
  repo: string;
  pullNumber: number;
  commitSha: string;
  body: string;
  comments: Array<{ path: string; line: number; body: string }>;
}

/** A fake GitHub client that serves a canned diff and records the review it is asked to post. */
function fakeGitHub(diff: string): {
  client: GitHubClient;
  reviews: CreatedReview[];
} {
  const reviews: CreatedReview[] = [];
  const client: GitHubClient = {
    async postIssueComment() {},
    async createReview(params) {
      reviews.push(params);
      // Hand back an id for the review and one for each inline comment, keyed to
      // the same file and line, mirroring what GitHub returns.
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
      return [];
    },
    async getFileContents() {
      return "";
    },
  };
  return { client, reviews };
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

/** Build a gated finding, mirroring the review engine's own gate decision. */
function gated(overrides: Partial<Finding> = {}): GatedFinding {
  const finding: Finding = {
    file: "x.ts",
    line: 10,
    severity: "high",
    category: "correctness",
    message: "This throws when x is null",
    confidence: 0.9,
    ...overrides,
  };
  return {
    ...finding,
    shouldPost:
      SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[SEVERITY_THRESHOLD],
  };
}

function reviewResult(overrides: Partial<ReviewResult> = {}): ReviewResult {
  return {
    findings: [],
    partial: false,
    model: "claude-opus-4-8",
    promptVersion: "test",
    ...overrides,
  };
}

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

describe("postReview", () => {
  it("posts findings above the gate as inline comments on the right lines", async () => {
    const { client, reviews } = fakeGitHub(DIFF_X_10_11);

    await postReview(
      prContext(),
      reviewResult({
        findings: [
          gated({ line: 10, message: "off by one" }),
          gated({ line: 11, severity: "critical", message: "null deref" }),
        ],
      }),
      { github: client },
    );

    expect(reviews).toHaveLength(1);
    const review = reviews[0]!;
    expect(review.commitSha).toBe("abc123");
    expect(review.comments).toHaveLength(2);
    expect(review.comments.map((c) => ({ path: c.path, line: c.line }))).toEqual(
      [
        { path: "x.ts", line: 10 },
        { path: "x.ts", line: 11 },
      ],
    );
    // Each inline body names the finding it carries.
    expect(review.comments[0]!.body).toContain("off by one");
    expect(review.comments[1]!.body).toContain("null deref");
    // The summary lists both findings with their file and line.
    expect(review.body).toContain("`x.ts:10`");
    expect(review.body).toContain("`x.ts:11`");
  });

  it("never posts sub-threshold findings inline or in the summary", async () => {
    const { client, reviews } = fakeGitHub(DIFF_X_10_11);

    await postReview(
      prContext(),
      reviewResult({
        findings: [
          gated({ line: 10, severity: "low", message: "tiny nit" }),
          gated({ line: 11, severity: "high", message: "real bug" }),
        ],
      }),
      { github: client },
    );

    const review = reviews[0]!;
    expect(review.comments).toHaveLength(1);
    expect(review.comments[0]!.line).toBe(11);
    expect(review.body).toContain("real bug");
    expect(review.body).not.toContain("tiny nit");
  });

  it("gives a clean pull request a summary only, with no inline comments", async () => {
    const { client, reviews } = fakeGitHub(DIFF_X_10_11);

    await postReview(prContext(), reviewResult({ findings: [] }), {
      github: client,
    });

    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.comments).toEqual([]);
    expect(reviews[0]!.body.toLowerCase()).toContain("nothing blocking");
  });

  it("folds a finding outside the diff into the summary rather than dropping it", async () => {
    const { client, reviews } = fakeGitHub(DIFF_X_10_11);

    await postReview(
      prContext(),
      reviewResult({
        // Line 99 is not in the diff — it has no inline anchor.
        findings: [gated({ line: 99, message: "unreachable inline" })],
      }),
      { github: client },
    );

    const review = reviews[0]!;
    expect(review.comments).toEqual([]);
    expect(review.body).toContain("unreachable inline");
    expect(review.body).toContain("`x.ts:99`");
  });

  it("says so honestly when the review was partial", async () => {
    const { client, reviews } = fakeGitHub(DIFF_X_10_11);

    await postReview(
      prContext(),
      reviewResult({ findings: [gated({ line: 10 })], partial: true }),
      { github: client },
    );

    expect(reviews[0]!.body.toLowerCase()).toContain("partial");
  });
});
