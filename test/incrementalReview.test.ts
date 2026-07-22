import { describe, expect, it } from "vitest";
import type {
  ChangedFile,
  GitHubClient,
  PullRequestContext,
} from "../src/github/client.js";
import type {
  ReviewModel,
  Finding,
} from "../src/model/reviewModel.js";
import { runReview } from "../src/review/runReview.js";
import { fingerprintFinding } from "../src/store/trainingStore.js";
import { createFakeTrainingStore } from "./helpers/fakeTrainingStore.js";

// The diff of a push: it adds lines 10 and 11 to x.ts, so those lines are
// postable. Stands in for what compareCommits returns for a synchronize event.
const PUSH_DIFF = [
  "diff --git a/x.ts b/x.ts",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -9,2 +9,4 @@",
  " const before = 1;",
  "+const a = 1;",
  "+const b = 2;",
  " const after = 3;",
].join("\n");

// A different diff for the whole pull request, so a test can tell which path
// (compare vs whole-PR) produced the review.
const WHOLE_PR_DIFF = [
  "diff --git a/x.ts b/x.ts",
  "--- a/x.ts",
  "+++ b/x.ts",
  "@@ -1,2 +1,4 @@",
  " const top = 0;",
  "+const a = 1;",
  "+const b = 2;",
  " const rest = 3;",
].join("\n");

function changed(filename: string): ChangedFile {
  return { filename, status: "modified", additions: 1, deletions: 0, changes: 1 };
}

interface CreatedReviewCall {
  comments: Array<{ path: string; line: number; body: string }>;
}

/** A fake GitHub client recording what was posted and which reads it served. */
function fakeGitHub(): {
  client: GitHubClient;
  reviews: CreatedReviewCall[];
  calls: { getPullRequestDiff: number; listChangedFiles: number };
} {
  const reviews: CreatedReviewCall[] = [];
  const calls = { getPullRequestDiff: 0, listChangedFiles: 0 };
  const client: GitHubClient = {
    async postIssueComment() {},
    async createReview(params) {
      reviews.push({ comments: params.comments });
      return {
        reviewId: 5000,
        comments: params.comments.map((comment, index) => ({
          path: comment.path,
          line: comment.line,
          id: 6000 + index,
        })),
      };
    },
    async getPullRequest() {
      return { headSha: "after-sha", isDraft: false };
    },
    async getPullRequestDiff() {
      calls.getPullRequestDiff += 1;
      return WHOLE_PR_DIFF;
    },
    async listChangedFiles() {
      calls.listChangedFiles += 1;
      return [changed("x.ts")];
    },
    async getFileContents() {
      return "const before = 1;\nconst a = 1;\nconst b = 2;\nconst after = 3;\n";
    },
    async compareCommits() {
      return { diff: PUSH_DIFF, files: [changed("x.ts")] };
    },
  };
  return { client, reviews, calls };
}

function fakeClaude(findings: Finding[]): ReviewModel {
  return {
    async review() {
      return { findings, model: "claude-opus-4-8" };
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
    headSha: "after-sha",
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

const scope = { diff: PUSH_DIFF, changedFiles: [changed("x.ts")] };

describe("incremental re-review on push", () => {
  it("posts nothing when the push produces no findings", async () => {
    const github = fakeGitHub();
    const { store, records } = createFakeTrainingStore();

    await runReview(prContext(), {
      github: github.client,
      claude: fakeClaude([]),
      store,
      scope,
    });

    // No findings, so no review is created — a "looks good" note on every push
    // would be spam. Nothing new is recorded either.
    expect(github.reviews).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it("suppresses a finding whose fingerprint was already posted", async () => {
    const repeat = finding({ line: 10 });
    const github = fakeGitHub();
    // Seed the store as if this exact finding already posted on an earlier pass.
    const { store, records } = createFakeTrainingStore({
      seedPosted: [fingerprintFinding("constant-eng", "widgets", repeat)],
    });

    await runReview(prContext(), {
      github: github.client,
      // The push re-flags the same problem, a couple of lines down.
      claude: fakeClaude([finding({ line: 11 })]),
      store,
      scope,
    });

    // The line moved but the content fingerprint did not, so it is recognised as
    // already posted and never posted again.
    expect(github.reviews).toHaveLength(0);
    expect(records).toHaveLength(0);
  });

  it("posts a genuinely new finding on the changed hunks", async () => {
    const github = fakeGitHub();
    const { store, records } = createFakeTrainingStore({
      seedPosted: ["some-old-unrelated-fingerprint"],
    });

    await runReview(prContext(), {
      github: github.client,
      claude: fakeClaude([finding({ line: 10, message: "a brand new bug" })]),
      store,
      scope,
    });

    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]!.comments).toEqual([
      expect.objectContaining({ path: "x.ts", line: 10 }),
    ]);
    // The new finding is recorded for training.
    expect(records).toHaveLength(1);
    expect(records[0]!.findings).toHaveLength(1);
    expect(records[0]!.findings[0]!.finding.message).toBe("a brand new bug");
  });

  it("records a genuinely new sub-threshold finding on a push without posting it", async () => {
    const github = fakeGitHub();
    const { store, records } = createFakeTrainingStore({
      seedPosted: ["some-old-unrelated-fingerprint"],
    });

    // A new low-severity finding: below the medium gate, so nothing worth
    // posting — but new to this pull request, so the store must keep it.
    await runReview(prContext(), {
      github: github.client,
      claude: fakeClaude([
        finding({ line: 10, severity: "low", message: "a new nit" }),
      ]),
      store,
      scope,
    });

    // No spam on the push, but the finding is captured for training, marked
    // not-posted, with the diff hunk the model saw.
    expect(github.reviews).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]!.findings).toHaveLength(1);
    const stored = records[0]!.findings[0]!;
    expect(stored.finding.message).toBe("a new nit");
    expect(stored.shouldPost).toBe(false);
    expect(stored.placement).toBe("not-posted");
    expect(stored.githubCommentId).toBeNull();
    expect(stored.diffHunk).not.toBeNull();
  });

  it("anchors inline comments against the push diff, not the whole pull request", async () => {
    const github = fakeGitHub();
    const { store } = createFakeTrainingStore();

    // The finding sits on line 10, which only the push diff touches; the
    // whole-PR diff touches lines 1-4. If it anchored against the whole-PR diff
    // the finding would fall outside it and fold into the summary instead.
    await runReview(prContext(), {
      github: github.client,
      claude: fakeClaude([finding({ line: 10 })]),
      store,
      scope,
    });

    expect(github.reviews[0]!.comments).toHaveLength(1);
    // The incremental path never reads the whole pull request.
    expect(github.calls.getPullRequestDiff).toBe(0);
    expect(github.calls.listChangedFiles).toBe(0);
  });

  it("first review with no scope still reviews the whole change", async () => {
    const github = fakeGitHub();
    const { store, records } = createFakeTrainingStore({
      // Even with an already-posted fingerprint, the opened path does not dedupe.
      seedPosted: [
        fingerprintFinding("constant-eng", "widgets", finding({ line: 2 })),
      ],
    });

    await runReview(prContext(), {
      github: github.client,
      // The finding anchors to line 2, which only the whole-PR diff touches.
      claude: fakeClaude([finding({ line: 2 })]),
      store,
      // No scope: the first review reads the whole pull request.
    });

    // It read the whole pull request and posted, dedupe left untouched.
    expect(github.calls.getPullRequestDiff).toBeGreaterThan(0);
    expect(github.calls.listChangedFiles).toBe(1);
    expect(github.reviews).toHaveLength(1);
    expect(github.reviews[0]!.comments).toEqual([
      expect.objectContaining({ path: "x.ts", line: 2 }),
    ]);
    expect(records).toHaveLength(1);
  });
});
