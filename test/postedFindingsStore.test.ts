import { describe, expect, it } from "vitest";
import type {
  BotCommentReader,
  GitHubClient,
  PostedCommentBody,
  PullRequestContext,
} from "../src/github/client.js";
import type { Finding } from "../src/model/reviewModel.js";
import type { GatedFinding, ReviewResult } from "../src/review/reviewPullRequest.js";
import { SEVERITY_THRESHOLD } from "../src/review/reviewPullRequest.js";
import { postReview } from "../src/review/postReview.js";
import {
  extractFingerprints,
  fingerprintMarker,
} from "../src/review/fingerprintMarker.js";
import { fingerprintFinding } from "../src/store/trainingStore.js";
import { createGitHubPostedFindingsStore } from "../src/store/postedFindingsStore.js";

const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 } as const;
const BOT = "postdev[bot]";

/** A bot-comment reader that serves canned inline comments and review bodies. */
function fakeReader(
  comments: PostedCommentBody[],
  reviews: PostedCommentBody[],
): BotCommentReader {
  return {
    async listReviewComments() {
      return comments;
    },
    async listReviews() {
      return reviews;
    },
  };
}

const QUERY = { owner: "acme", repo: "widgets", pullNumber: 7 };

describe("fingerprint marker", () => {
  it("round-trips a fingerprint through the marker", () => {
    const fp = "a".repeat(64);
    expect(extractFingerprints(fingerprintMarker(fp))).toEqual([fp]);
  });

  it("pulls every marker out of a body that carries several", () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const body = `- one ${fingerprintMarker(a)}\n- two ${fingerprintMarker(b)}`;
    expect(extractFingerprints(body)).toEqual([a, b]);
  });

  it("finds no marker in an ordinary body", () => {
    expect(extractFingerprints("just a normal comment")).toEqual([]);
  });
});

describe("createGitHubPostedFindingsStore", () => {
  it("returns an empty set when the bot has posted nothing", async () => {
    const store = createGitHubPostedFindingsStore(fakeReader([], []), BOT);
    expect(await store.postedFingerprints(QUERY)).toEqual(new Set());
  });

  it("collects markers from the bot's inline comments and review bodies", async () => {
    const a = "a".repeat(64);
    const b = "b".repeat(64);
    const store = createGitHubPostedFindingsStore(
      fakeReader(
        [{ author: BOT, body: `nit ${fingerprintMarker(a)}` }],
        [{ author: BOT, body: `summary ${fingerprintMarker(b)}` }],
      ),
      BOT,
    );
    expect(await store.postedFingerprints(QUERY)).toEqual(new Set([a, b]));
  });

  it("ignores markers in comments the bot did not write", async () => {
    const mine = "a".repeat(64);
    const theirs = "b".repeat(64);
    const store = createGitHubPostedFindingsStore(
      fakeReader(
        [
          { author: BOT, body: `mine ${fingerprintMarker(mine)}` },
          { author: "a-human", body: `quoted ${fingerprintMarker(theirs)}` },
          { author: null, body: `anon ${fingerprintMarker(theirs)}` },
        ],
        [],
      ),
      BOT,
    );
    expect(await store.postedFingerprints(QUERY)).toEqual(new Set([mine]));
  });

  it("matches the bot login case-insensitively", async () => {
    const fp = "c".repeat(64);
    const store = createGitHubPostedFindingsStore(
      fakeReader([{ author: "PostDev[bot]", body: fingerprintMarker(fp) }], []),
      "postdev[bot]",
    );
    expect(await store.postedFingerprints(QUERY)).toEqual(new Set([fp]));
  });
});

// --- End-to-end: what postReview posts is exactly what the store reads back ---

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

const PR: PullRequestContext = {
  owner: "acme",
  repo: "widgets",
  pullNumber: 7,
  isDraft: false,
  headSha: "head1",
};

// Adds lines 10 and 11 to x.ts, so both are postable inline; line 99 is not.
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

/**
 * Post a review with the given findings and feed everything the bot posted — the
 * inline comment bodies and the summary body — back through a reader as the bot,
 * so a store can reconstruct from exactly what a real re-review would read.
 */
async function postThenRead(findings: GatedFinding[]): Promise<Set<string>> {
  const inlineBodies: PostedCommentBody[] = [];
  let summaryBody = "";
  const github: GitHubClient = {
    async postIssueComment() {},
    async createReview(params) {
      summaryBody = params.body;
      for (const comment of params.comments) {
        inlineBodies.push({ author: BOT, body: comment.body });
      }
      return {
        reviewId: 1,
        comments: params.comments.map((c, i) => ({
          path: c.path,
          line: c.line,
          id: 100 + i,
        })),
      };
    },
    async getPullRequestDiff() {
      return DIFF;
    },
    async listChangedFiles() {
      return [];
    },
    async getFileContents() {
      return "";
    },
  };

  const result: ReviewResult = {
    findings,
    partial: false,
    model: "m",
    promptVersion: "v",
  };
  await postReview(PR, result, { github, diff: DIFF });

  const store = createGitHubPostedFindingsStore(
    fakeReader(inlineBodies, [{ author: BOT, body: summaryBody }]),
    BOT,
  );
  return store.postedFingerprints(QUERY);
}

describe("postReview markers round-trip through the store", () => {
  it("reconstructs the fingerprint of an inline finding", async () => {
    const finding = gated({ line: 10, message: "off by one" });
    const posted = await postThenRead([finding]);
    expect(posted).toEqual(
      new Set([fingerprintFinding(PR.owner, PR.repo, finding)]),
    );
  });

  it("reconstructs the fingerprint of a summary-folded finding", async () => {
    const finding = gated({ line: 99, message: "outside the diff" });
    const posted = await postThenRead([finding]);
    expect(posted).toEqual(
      new Set([fingerprintFinding(PR.owner, PR.repo, finding)]),
    );
  });

  it("does not reconstruct a sub-threshold finding that was never posted", async () => {
    const posted = await postThenRead([
      gated({ line: 10, severity: "low", message: "tiny nit" }),
    ]);
    expect(posted).toEqual(new Set());
  });

  it("dedupes the same problem after it shifts to a new line", async () => {
    // The fingerprint leaves the line out on purpose, so the same finding moved
    // a few lines down by a later push still reconstructs to the same value.
    const atLine10 = gated({ line: 10, message: "same bug" });
    const posted = await postThenRead([atLine10]);
    const atLine13 = gated({ line: 13, message: "same bug" });
    expect(posted.has(fingerprintFinding(PR.owner, PR.repo, atLine13))).toBe(
      true,
    );
  });
});
