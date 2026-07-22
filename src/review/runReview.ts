import type {
  ChangedFile,
  GitHubClient,
  PullRequestContext,
} from "../github/client.js";
import type { ReviewModel, Severity } from "../model/reviewModel.js";
import {
  fingerprintFinding,
  type PostedFindingsStore,
  type TrainingReviewRecord,
  type TrainingStore,
} from "../store/trainingStore.js";
import { reviewPullRequest, type ReviewResult } from "./reviewPullRequest.js";
import {
  extractDiffHunk,
  postReview,
  type PostReviewOutcome,
} from "./postReview.js";
import type { GatedFinding } from "./reviewPullRequest.js";
import type { Logger } from "./handlePullRequestOpened.js";

const noopLogger: Logger = { info() {} };

export interface RunReviewDeps {
  github: GitHubClient;
  claude: ReviewModel;
  /**
   * Where to persist the review for training. Optional: without it (no
   * DATABASE_URL) the bot still reviews and posts, it just records nothing.
   */
  store?: TrainingStore;
  /**
   * The dedupe source for incremental re-review: which fingerprints have already
   * been posted on this pull request. The open-source engine injects the store
   * that reconstructs this from the bot's prior comments; the enterprise host can
   * pass its Postgres store here (it satisfies this narrow interface too). When
   * omitted, dedupe falls back to {@link store}, so an enterprise caller that
   * passes only `store` still dedupes as before.
   */
  postedFindings?: PostedFindingsStore;
  /** Post findings at or above this severity; below it they are kept but not
   * shown. Defaults to the engine's threshold. Wired to the Action's
   * `min-severity` input. */
  minSeverity?: Severity;
  logger?: Logger;
  /** Override the size cap — tests use this to exercise the partial path. */
  maxContextBytes?: number;
  /**
   * Scope the review to one push instead of the whole pull request. Incremental
   * re-review (ticket 05) sets this to the diff and file list of the commits
   * just pushed; the review and the inline anchoring both use it, so only the
   * newly-changed hunks are reviewed. When set with a store, findings whose
   * fingerprint was already posted on this pull request are dropped before
   * posting, so a developer never sees the same comment twice. Omitted on the
   * first review and on a manual re-review, which both cover the whole change.
   */
  scope?: { diff: string; changedFiles: ChangedFile[] };
}

/**
 * Turn one posted review into the append-only record the store persists: the
 * review's own metadata plus one entry per finding, each carrying the whole
 * structured finding, its posting outcome and diff hunk, a content fingerprint,
 * and its own model and prompt-version stamps.
 */
export function buildTrainingRecord(
  pr: PullRequestContext,
  result: ReviewResult,
  outcome: PostReviewOutcome,
): TrainingReviewRecord {
  return {
    owner: pr.owner,
    repo: pr.repo,
    pullNumber: pr.pullNumber,
    headSha: pr.headSha,
    modelId: result.model,
    promptVersion: result.promptVersion,
    partial: result.partial,
    githubReviewId: outcome.reviewId,
    findings: outcome.findings.map((posted) => ({
      finding: posted.finding,
      shouldPost: posted.finding.shouldPost,
      placement: posted.placement,
      diffHunk: posted.diffHunk,
      githubCommentId: posted.commentId,
      fingerprint: fingerprintFinding(pr.owner, pr.repo, posted.finding),
      modelId: result.model,
      promptVersion: result.promptVersion,
    })),
  };
}

/**
 * Build a posting outcome for findings that were reviewed but never posted —
 * the incremental case where a push turns up only new sub-threshold findings.
 * Nothing goes to GitHub (no review id, no comment ids), but each finding still
 * carries the diff hunk the model saw, so the store keeps a full training row.
 */
function notPostedOutcome(
  findings: GatedFinding[],
  diff: string,
): PostReviewOutcome {
  return {
    reviewId: null,
    findings: findings.map((finding) => ({
      finding,
      placement: "not-posted",
      diffHunk: extractDiffHunk(diff, finding.file, finding.line),
      commentId: null,
    })),
  };
}

/**
 * The whole review flow for one pull request: review it, post the findings, and
 * — when a store is injected — persist the review and every finding. All three
 * collaborators are injected, so a test drives the flow with fakes and asserts
 * on what the store was asked to write. A store failure must not swallow the
 * posted review, so it surfaces to the caller (the webhook logs and moves on).
 */
export async function runReview(
  pr: PullRequestContext,
  deps: RunReviewDeps,
): Promise<void> {
  const logger = deps.logger ?? noopLogger;
  const prMeta = { owner: pr.owner, repo: pr.repo, pullNumber: pr.pullNumber };

  const result = await reviewPullRequest(pr, {
    github: deps.github,
    claude: deps.claude,
    logger,
    minSeverity: deps.minSeverity,
    maxContextBytes: deps.maxContextBytes,
    changeSet: deps.scope
      ? { diff: deps.scope.diff, changedFiles: deps.scope.changedFiles }
      : undefined,
  });

  // On an incremental re-review, drop any finding already posted on this pull
  // request. We match on the stored line-independent fingerprint: the same
  // problem re-flagged a few lines down after a push is still the same finding,
  // so dedupe must survive the line shift the push caused. See the note on
  // fingerprintFinding. Dedupe runs only on the incremental path — the first
  // review has nothing to dedupe against, and a manual re-review is meant to
  // repost the whole change.
  let findings = result.findings;
  const dedupeStore = deps.postedFindings ?? deps.store;
  if (deps.scope && dedupeStore) {
    const alreadyPosted = await dedupeStore.postedFingerprints(prMeta);
    findings = findings.filter(
      (finding) =>
        !alreadyPosted.has(fingerprintFinding(pr.owner, pr.repo, finding)),
    );
  }

  // After dedupe, if an incremental pass has nothing left worth posting, post
  // nothing at all — a "looks good" summary on every push would be spam.
  // Already-posted findings were dropped by dedupe, but any finding still here
  // is genuinely new to this pull request, so a new sub-threshold finding must
  // still be recorded for training even though it is not worth posting. Skip
  // the posting, keep the store write.
  const scopedResult: ReviewResult = { ...result, findings };
  if (deps.scope && !findings.some((finding) => finding.shouldPost)) {
    logger.info("Incremental re-review: no new findings to post", prMeta);
    if (deps.store && findings.length > 0) {
      const outcome = notPostedOutcome(findings, deps.scope.diff);
      await deps.store.recordReview(
        buildTrainingRecord(pr, scopedResult, outcome),
      );
      logger.info("Recorded not-posted findings for training", {
        ...prMeta,
        findings: findings.length,
      });
    }
    return;
  }

  const outcome = await postReview(pr, scopedResult, {
    github: deps.github,
    logger,
    diff: deps.scope?.diff,
  });

  if (deps.store) {
    await deps.store.recordReview(buildTrainingRecord(pr, scopedResult, outcome));
    logger.info("Recorded review for training", {
      ...prMeta,
      findings: outcome.findings.length,
    });
  }
}
