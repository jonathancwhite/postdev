import { createHash } from "node:crypto";
import type { Finding } from "../model/reviewModel.js";

/**
 * Where a finding ended up on GitHub. "inline" means it posted as an inline
 * comment anchored to its line; "summary" means it was folded into the review's
 * summary because its line fell outside the diff; "not-posted" means it stayed
 * below the severity gate and was kept only for training. Every finding gets one
 * of these — nothing is silently dropped.
 */
export type FindingPlacement = "inline" | "summary" | "not-posted";

/**
 * One finding as it is written to the store. The whole structured finding is
 * kept intact (stored as jsonb) rather than flattened, so no field is lost. Each
 * row is stamped with its own model id and prompt version: a later prompt change
 * appends new rows and never rewrites these, so old training data stays honest.
 */
export interface TrainingFindingRecord {
  /** The full structured finding the model returned, kept whole. */
  finding: Finding;
  /** True when the finding cleared the severity gate. */
  shouldPost: boolean;
  /** Where the finding was posted, or that it was not posted. */
  placement: FindingPlacement;
  /** The unified-diff hunk the model saw for this finding, or null if none. */
  diffHunk: string | null;
  /** GitHub inline comment id, when it posted inline; null otherwise. */
  githubCommentId: number | null;
  /**
   * A content fingerprint, stable across pull requests and line shifts. Ticket
   * 05 (dedupe) queries this to find findings it has already posted.
   */
  fingerprint: string;
  /** The model that produced this finding, stamped per row. */
  modelId: string;
  /** The prompt version that produced this finding, stamped per row. */
  promptVersion: string;
}

/** One review and every finding it produced, ready to persist. */
export interface TrainingReviewRecord {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  /** Which model produced the review's findings. */
  modelId: string;
  /** The prompt version that produced the review. */
  promptVersion: string;
  /** True when the pull request was too big to read in full. */
  partial: boolean;
  /** The GitHub review id, or null if nothing was posted. */
  githubReviewId: number | null;
  findings: TrainingFindingRecord[];
}

/** Which pull request to read already-posted fingerprints for. */
export interface PostedFingerprintQuery {
  owner: string;
  repo: string;
  pullNumber: number;
}

/**
 * The kinds of thing that can happen to a finding after it is posted, plus the
 * human reviewer activity mirrored beside it. Kept as a raw stream — none of
 * these is ever collapsed into an accepted/rejected verdict; a label is computed
 * later, at training time, from the events themselves.
 */
export type OutcomeEventType =
  /** The bot's inline comment thread was marked resolved by a human. */
  | "thread_resolved"
  /** A previously-resolved bot thread was reopened. */
  | "thread_unresolved"
  /** A flagged line was touched by a later push (recorded with its timing). */
  | "flagged_line_changed"
  /** Someone replied on the bot's inline comment thread. */
  | "bot_comment_reply"
  /** A human submitted a final review (approved / changes_requested / commented). */
  | "human_review_submitted"
  /** A human left their own inline review comment on the pull request. */
  | "human_review_comment"
  /** A human left a conversation-level comment on the pull request. */
  | "human_conversation_comment";

/**
 * One raw outcome or mirrored-activity event, ready to append. `findingId` ties
 * it back to the bot finding it is about, or is null for PR-level human activity
 * that maps to no finding — the pull-request identity is always carried so such
 * activity is still stored. `payload` is the raw slice of the webhook event,
 * kept whole. Nothing here is a verdict.
 */
export interface OutcomeEvent {
  /** The finding this event is about, or null for unlinked human activity. */
  findingId: number | null;
  owner: string;
  repo: string;
  pullNumber: number;
  eventType: OutcomeEventType;
  /** Who acted, or null when the source names no user. */
  actorLogin: string | null;
  /** True when the actor is the bot, so human activity is never confused for it. */
  actorIsBot: boolean;
  /** The raw event slice, stored whole as jsonb. */
  payload: unknown;
  /** When GitHub says it happened (ISO 8601), or null when the source has none. */
  githubCreatedAt: string | null;
}

/** Locate the finding a webhook comment or thread belongs to. */
export interface CommentLookupQuery {
  owner: string;
  repo: string;
  pullNumber: number;
  /** The GitHub inline comment id the bot posted, as recorded on the finding. */
  githubCommentId: number;
}

/** One posted finding's location, used to detect when its flagged line changes. */
export interface PostedFindingLocation {
  /** The stable finding id (findings.id) an event links back to. */
  findingId: number;
  file: string;
  line: number;
  /** The GitHub inline comment id, when it posted inline; null otherwise. */
  githubCommentId: number | null;
}

/**
 * The dedupe seam the review engine depends on, and nothing more: "which finding
 * fingerprints have already been posted on this pull request?" This is the one
 * piece of persistence the open-source engine needs to behave well across
 * pushes, so it stands on its own. The enterprise Postgres store answers it from
 * a database; the open-source default reconstructs it from the bot's own prior
 * pull-request comments, so cross-push dedupe works with no store at all.
 */
export interface PostedFindingsStore {
  /**
   * The fingerprints of findings already POSTED (inline or summary) on one pull
   * request. Incremental re-review reads this on each push and drops any finding
   * whose fingerprint is already here, so the developer never sees the same
   * comment twice. Not-posted (sub-threshold) findings are left out — they were
   * never shown, so there is nothing to dedupe against.
   */
  postedFingerprints(query: PostedFingerprintQuery): Promise<Set<string>>;
}

/**
 * The full training corpus: every review, every finding, and the raw outcome and
 * human-activity events beside them. This is the proprietary slice — the
 * enterprise Postgres store implements it, and the open-source engine ships a
 * no-op default. It extends {@link PostedFindingsStore} so one Postgres-backed
 * object still satisfies both the corpus and the dedupe seam. A real store and an
 * in-memory fake both satisfy it, so the flow's tests inject the fake and assert
 * on the rows written without standing up a database.
 */
export interface TrainingStore extends PostedFindingsStore {
  /** Append one review and all its findings. Rows are never overwritten. */
  recordReview(record: TrainingReviewRecord): Promise<void>;

  /**
   * Append one raw outcome or mirrored-activity event. Append-only, like
   * {@link recordReview}: events accrete against a finding (or a pull request)
   * and are never overwritten or collapsed into a verdict.
   */
  recordEvent(event: OutcomeEvent): Promise<void>;

  /**
   * Resolve a GitHub inline comment id back to the finding it belongs to, or
   * null when no posted finding matches. A webhook (a resolved thread, a reply)
   * names a comment id; this turns it into the stable finding id an event links
   * to.
   */
  findFindingByCommentId(query: CommentLookupQuery): Promise<number | null>;

  /**
   * Every posted finding on one pull request, with the file and line it was
   * flagged on. The push handler reads these to spot findings whose flagged line
   * a later commit touched, so it can record a `flagged_line_changed` event.
   */
  postedFindingLocations(
    query: PostedFingerprintQuery,
  ): Promise<PostedFindingLocation[]>;
}

/**
 * A content fingerprint for a finding, stable across pull requests and across
 * line shifts. Line is deliberately left out so the same problem re-detected a
 * few lines down still hashes the same. Ticket 05 dedupes on this.
 */
export function fingerprintFinding(
  owner: string,
  repo: string,
  finding: Finding,
): string {
  return createHash("sha256")
    .update(
      [owner, repo, finding.file, finding.severity, finding.category, finding.message].join(
        " ",
      ),
    )
    .digest("hex");
}
