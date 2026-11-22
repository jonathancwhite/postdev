import type { GitHubClient, PullRequestContext } from "../github/client.js";
import type { ReviewAxis, Severity } from "../model/reviewModel.js";
import type { GatedFinding, ReviewResult } from "./reviewPullRequest.js";
import { fingerprintFinding, type FindingPlacement } from "../store/trainingStore.js";
import { fingerprintMarker } from "./fingerprintMarker.js";
import type { Logger } from "./handlePullRequestOpened.js";

/** One finding and the record of what happened to it when the review posted. */
export interface PostedFinding {
  finding: GatedFinding;
  /** Where the finding ended up: inline, folded into the summary, or not posted. */
  placement: FindingPlacement;
  /** The diff hunk the model saw for this finding, or null if outside the diff. */
  diffHunk: string | null;
  /** The GitHub inline comment id, when it posted inline; null otherwise. */
  commentId: number | null;
}

/**
 * What a posted review did, surfaced so the caller can persist it. Covers every
 * finding — inline, summary, and sub-threshold not-posted alike — so nothing is
 * lost between posting and the store.
 */
export interface PostReviewOutcome {
  /** The GitHub review id, or null if no review was created. */
  reviewId: number | null;
  findings: PostedFinding[];
}

const noopLogger: Logger = { info() {} };

/** The bot's byline, so its review is plainly not from a person. */
const BOT_HEADING = "🔍 **PostDev**";

export interface PostReviewDeps {
  github: GitHubClient;
  logger?: Logger;
  /**
   * Anchor the inline comments against this diff instead of the whole pull
   * request. Incremental re-review (ticket 05) passes the newest push's diff, so
   * a finding can only anchor to a line that push touched. Omitted on the first
   * review, which reads the whole pull request diff as before.
   */
  diff?: string;
}

/**
 * Parse a unified diff into the set of new-side line numbers that can carry an
 * inline comment, keyed by file path. GitHub accepts an inline comment only on a
 * line the diff touches — an added line or a context line on the new side. A
 * finding whose line is not in this set has no anchor and must fold into the
 * summary instead of being dropped.
 */
export function parsePostableLines(diff: string): Map<string, Set<number>> {
  const postable = new Map<string, Set<number>>();
  let path: string | undefined;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      // "+++ b/src/x.ts" names the new file; "/dev/null" means it was removed.
      const target = line.slice(4).trim();
      path = target === "/dev/null" ? undefined : stripPrefix(target);
      if (path && !postable.has(path)) postable.set(path, new Set());
      continue;
    }
    if (line.startsWith("@@")) {
      // "@@ -a,b +c,d @@" — c is where the new-side hunk starts.
      const match = /\+(\d+)/.exec(line.slice(2));
      newLine = match ? Number(match[1]) : 0;
      continue;
    }
    if (!path) continue;
    if (line.startsWith("+")) {
      postable.get(path)?.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // A removed line advances only the old side, so the new counter holds.
    } else if (line.startsWith(" ")) {
      postable.get(path)?.add(newLine);
      newLine += 1;
    }
  }

  return postable;
}

/** Drop a leading "a/" or "b/" that unified diffs put on their paths. */
function stripPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

/**
 * Pull the single diff hunk that a finding sits in out of the unified diff — the
 * `@@` header and its body lines. This is the slice of diff the model saw for
 * that finding, kept beside it in the store as training context. A finding whose
 * line falls outside every hunk (or in a file the diff does not touch) has no
 * hunk, so this returns null rather than guessing.
 */
export function extractDiffHunk(
  diff: string,
  file: string,
  line: number,
): string | null {
  let path: string | undefined;
  let buffer: string[] = [];
  let bufferPath: string | undefined;
  let newLine = 0;
  let matched = false;

  const flush = (): string | null =>
    matched && bufferPath === file && buffer.length > 0
      ? buffer.join("\n")
      : null;

  for (const row of diff.split("\n")) {
    if (row.startsWith("diff ") || row.startsWith("--- ")) {
      const done = flush();
      if (done !== null) return done;
      buffer = [];
      matched = false;
      continue;
    }
    if (row.startsWith("+++ ")) {
      const done = flush();
      if (done !== null) return done;
      buffer = [];
      matched = false;
      const target = row.slice(4).trim();
      path = target === "/dev/null" ? undefined : stripPrefix(target);
      continue;
    }
    if (row.startsWith("@@")) {
      const done = flush();
      if (done !== null) return done;
      buffer = [row];
      bufferPath = path;
      matched = false;
      const match = /\+(\d+)/.exec(row.slice(2));
      newLine = match ? Number(match[1]) : 0;
      continue;
    }
    if (buffer.length === 0) continue; // outside any hunk
    buffer.push(row);
    if (row.startsWith("+") || row.startsWith(" ")) {
      if (newLine === line && bufferPath === file) matched = true;
      newLine += 1;
    }
    // A "-" line advances the old side only; "\" (no-newline marker) is ignored.
  }

  return flush();
}

const SEVERITY_LABEL: Record<Severity, string> = {
  low: "LOW",
  medium: "MEDIUM",
  high: "HIGH",
  critical: "CRITICAL",
};

const AXIS_LABEL: Record<ReviewAxis, string> = {
  standards: "Standards",
  spec: "Spec",
};

/** "[HIGH] Spec · missing requirement", or the bare category for an older finding. */
function findingLabel(finding: GatedFinding): string {
  const kind = finding.axis
    ? `${AXIS_LABEL[finding.axis]} · ${finding.category}`
    : finding.category;
  return `**[${SEVERITY_LABEL[finding.severity]}] ${kind}**`;
}

/** The one-line body of an inline comment, e.g. "**[HIGH] Spec · scope creep** — …". */
function inlineBody(finding: GatedFinding): string {
  return `${BOT_HEADING} · ${findingLabel(finding)} — ${finding.message}`;
}

/** The one-line entry a finding gets in the summary list. */
function summaryLine(finding: GatedFinding): string {
  return `- \`${finding.file}:${finding.line}\` ${findingLabel(finding)} — ${finding.message}`;
}

/**
 * Split the postable findings into ones that can be anchored inline and ones
 * whose line falls outside the diff. The second group is never dropped — it is
 * returned so the summary can carry it as a file-level note.
 */
function splitByAnchor(
  findings: GatedFinding[],
  postableLines: Map<string, Set<number>>,
): { inline: GatedFinding[]; unanchored: GatedFinding[] } {
  const inline: GatedFinding[] = [];
  const unanchored: GatedFinding[] = [];
  for (const finding of findings) {
    if (postableLines.get(finding.file)?.has(finding.line)) {
      inline.push(finding);
    } else {
      unanchored.push(finding);
    }
  }
  return { inline, unanchored };
}

/**
 * Build the summary body: the bot byline, an honest partial-pass note when the
 * pull request was too big for a full read, then either a "nothing blocking"
 * line for a clean pull request or a list of every finding worth posting.
 * Findings that could not be anchored to the diff are marked as such so a
 * reader knows why they have no inline note.
 */
function buildSummary(
  owner: string,
  repo: string,
  inline: GatedFinding[],
  unanchored: GatedFinding[],
  partial: boolean,
  specReviewed: boolean | undefined,
): string {
  const parts: string[] = [BOT_HEADING, ""];

  if (partial) {
    parts.push(
      "This pull request was too big to read in full — this is a partial pass, not a complete review.",
      "",
    );
  }

  const specNote =
    specReviewed === false
      ? ["", "_Spec: skipped, because this pull request links no issue. Only coding standards were checked._"]
      : [];

  const total = inline.length + unanchored.length;
  if (total === 0) {
    parts.push("Looks good — nothing blocking.", ...specNote);
    return parts.join("\n");
  }

  // Inline findings carry their fingerprint marker on their inline comment, so
  // their summary line needs none. An unanchored finding has no inline comment,
  // so its marker rides here — its only home for a later run to read it back.
  const lines = (findings: GatedFinding[]): string[] => [
    ...findings.filter((f) => inline.includes(f)).map(summaryLine),
    ...findings
      .filter((f) => unanchored.includes(f))
      .map(
        (f) =>
          `${summaryLine(f)} _(outside the diff — no inline anchor)_ ${fingerprintMarker(
            fingerprintFinding(owner, repo, f),
          )}`,
      ),
  ];

  const all = [...inline, ...unanchored];
  parts.push(`Caught ${total} thing${total === 1 ? "" : "s"} worth a look:`, "");
  if (!all.some((finding) => finding.axis)) {
    parts.push(...lines(all));
    return parts.join("\n");
  }

  // The two axes are reported separately and never ranked against each other:
  // a change can follow every standard and still miss its issue, or the reverse.
  for (const axis of ["standards", "spec"] as const) {
    const ofAxis = all.filter((finding) => finding.axis === axis);
    if (ofAxis.length === 0) continue;
    parts.push(`**${AXIS_LABEL[axis]}**`, ...lines(ofAxis), "");
  }
  const other = all.filter((finding) => !finding.axis);
  if (other.length > 0) parts.push(...lines(other), "");
  if (parts[parts.length - 1] === "") parts.pop();
  parts.push(...specNote);
  return parts.join("\n");
}

/**
 * Turn a {@link ReviewResult} into real feedback on the pull request: one
 * COMMENT-type review carrying an inline comment on each postable finding and a
 * closing summary. It fetches the diff to learn which lines can hold an inline
 * comment; a finding on a line outside the diff folds into the summary rather
 * than being dropped. A clean pull request gets a short summary and no inline
 * comments. The review is advisory — it never approves or requests changes.
 *
 * Its collaborator, the GitHub client, is injected, so tests drive it with a
 * fake and assert on the exact inline and summary payloads it tries to post.
 *
 * It returns a {@link PostReviewOutcome} describing what happened to every
 * finding — inline, summary, or not-posted, each with its diff hunk and, for
 * inline ones, the GitHub comment id — so the caller can persist the review.
 */
export async function postReview(
  pr: PullRequestContext,
  result: ReviewResult,
  deps: PostReviewDeps,
): Promise<PostReviewOutcome> {
  const logger = deps.logger ?? noopLogger;
  const prMeta = { owner: pr.owner, repo: pr.repo, pullNumber: pr.pullNumber };

  const toPost = result.findings.filter((finding) => finding.shouldPost);
  const diff = deps.diff ?? (await deps.github.getPullRequestDiff(prMeta));
  const { inline, unanchored } = splitByAnchor(toPost, parsePostableLines(diff));

  const body = buildSummary(
    pr.owner,
    pr.repo,
    inline,
    unanchored,
    result.partial,
    result.specReviewed,
  );
  // Each inline comment carries an invisible fingerprint marker, so a later run
  // can read the bot's own comments back and skip a finding it already posted —
  // cross-push dedupe with no store behind it.
  const comments = inline.map((finding) => ({
    path: finding.file,
    line: finding.line,
    body: `${inlineBody(finding)}\n\n${fingerprintMarker(
      fingerprintFinding(pr.owner, pr.repo, finding),
    )}`,
  }));

  const created = await deps.github.createReview({
    ...prMeta,
    commitSha: pr.headSha,
    body,
    comments,
  });

  // Match each inline finding to the comment GitHub created for it, by file and
  // line. `used` keeps two findings on the same line from claiming one comment.
  const inlineSet = new Set(inline);
  const used = new Set<number>();
  const commentIdFor = (finding: GatedFinding): number | null => {
    for (const comment of created.comments) {
      if (
        comment.path === finding.file &&
        comment.line === finding.line &&
        !used.has(comment.id)
      ) {
        used.add(comment.id);
        return comment.id;
      }
    }
    return null;
  };

  // Record what happened to every finding, sub-threshold ones included.
  const findings: PostedFinding[] = result.findings.map((finding) => {
    const placement: FindingPlacement = !finding.shouldPost
      ? "not-posted"
      : inlineSet.has(finding)
        ? "inline"
        : "summary";
    return {
      finding,
      placement,
      diffHunk: extractDiffHunk(diff, finding.file, finding.line),
      commentId: placement === "inline" ? commentIdFor(finding) : null,
    };
  });

  logger.info("Posted review", {
    ...prMeta,
    inline: comments.length,
    unanchored: unanchored.length,
    partial: result.partial,
  });

  return { reviewId: created.reviewId, findings };
}
