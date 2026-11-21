import type { PullRequestContext } from "../github/client.js";
import type { BlastRadiusTarget } from "../blastRadius/runBlastRadius.js";

/** The loose shape of a `pull_request` event payload, as far as we read it. */
export interface PullRequestEventPayload {
  action?: string;
  /** On a `synchronize` (a new push): the pull request's previous head. */
  before?: string;
  /** On a `synchronize` (a new push): the pull request's new head. */
  after?: string;
  pull_request?: {
    number?: number;
    draft?: boolean;
    head?: { sha?: string };
  };
}

/** Which repository the event fired on. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * What to review, worked out from a GitHub Action event. `push` is set only on a
 * new push (`synchronize`), carrying the range to re-review incrementally; it is
 * absent when a pull request opens, reopens, or is marked ready.
 */
export interface ActionReviewTarget {
  pr: PullRequestContext;
  push?: { before: string; after: string };
}

/** The pull-request actions the bot reviews. Everything else is left alone. */
const REVIEWED_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
]);

/**
 * Decide what a GitHub Action run should review, or null when the event is not
 * one to act on. This is the whole of the adapter's decision-making, kept pure
 * and free of the Actions runtime so a test can drive it with a plain payload.
 *
 * It mirrors the webhook front door exactly: review a pull request when it opens,
 * reopens, is marked ready, or gets a new push; never review a draft — the bot
 * reviews finished intent only. A push carries its before/after range so the
 * caller can scope the re-review to just what changed.
 */
export function reviewTargetFromEvent(
  eventName: string,
  payload: PullRequestEventPayload,
  repo: RepoRef,
): ActionReviewTarget | null {
  if (eventName !== "pull_request") return null;

  const action = payload.action;
  if (typeof action !== "string" || !REVIEWED_ACTIONS.has(action)) return null;

  const pull = payload.pull_request;
  const pullNumber = pull?.number;
  const headSha = pull?.head?.sha;
  if (pullNumber === undefined || headSha === undefined) return null;

  // Drafts are work in progress — no review, exactly as the webhook path drops
  // them.
  if (pull?.draft ?? false) return null;

  const pr: PullRequestContext = {
    owner: repo.owner,
    repo: repo.repo,
    pullNumber,
    isDraft: false,
    headSha,
  };

  if (action === "synchronize" && payload.before && payload.after) {
    return { pr, push: { before: payload.before, after: payload.after } };
  }
  return { pr };
}

/** The `pull_request` actions that (re)work out the blast radius. */
const BLAST_RADIUS_ACTIONS = new Set([
  "opened",
  "reopened",
  "ready_for_review",
  "synchronize",
  "labeled",
  "unlabeled",
]);

/** The extra payload fields the blast-radius check reads. */
export interface BlastRadiusEventPayload extends PullRequestEventPayload {
  pull_request?: PullRequestEventPayload["pull_request"] & {
    base?: { sha?: string };
    labels?: Array<{ name?: string }>;
    changed_files?: number;
  };
}

/**
 * Decide which pull request a run should work out the blast radius for, or null.
 * Unlike the review, drafts are included, and adding or removing a label re-runs
 * it, so a person's override label takes effect at once.
 */
export function blastRadiusTargetFromEvent(
  eventName: string,
  payload: BlastRadiusEventPayload,
  repo: RepoRef,
): BlastRadiusTarget | null {
  if (eventName !== "pull_request") return null;
  if (typeof payload.action !== "string" || !BLAST_RADIUS_ACTIONS.has(payload.action)) {
    return null;
  }
  const pull = payload.pull_request;
  const pullNumber = pull?.number;
  const headSha = pull?.head?.sha;
  const baseSha = pull?.base?.sha;
  if (pullNumber === undefined || !headSha || !baseSha) return null;
  return {
    owner: repo.owner,
    repo: repo.repo,
    pullNumber,
    headSha,
    baseSha,
    labels: (pull?.labels ?? []).flatMap((l) => (l.name ? [l.name] : [])),
    ...(typeof pull?.changed_files === "number" ? { changedFileCount: pull.changed_files } : {}),
  };
}
