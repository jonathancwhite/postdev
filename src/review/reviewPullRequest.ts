import type {
  ChangedFile,
  GitHubClient,
  PullRequestContext,
} from "../github/client.js";
import type {
  ReviewModel,
  Finding,
  ReviewFile,
  Severity,
} from "../model/reviewModel.js";
import { PROMPT_VERSION } from "../model/reviewModel.js";
import type { Logger } from "./handlePullRequestOpened.js";

const noopLogger: Logger = { info() {} };

/**
 * The severity at or above which a finding is posted. Findings below it are
 * still kept (later tickets store them) but marked not-to-post. "medium" means
 * only "low" findings are held back — it is the one knob to tune once we know
 * the false-positive rate. Ranked here so the gate is a simple comparison.
 */
export const SEVERITY_THRESHOLD: Severity = "medium";

const SEVERITY_RANK: Record<Severity, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Cap on how much text we send the model, measured in bytes of diff plus full
 * file contents. 400 KB comfortably holds a normal pull request while keeping a
 * runaway one from blowing the context window. A pull request over the cap is
 * reviewed partially and flagged — never silently truncated.
 */
export const MAX_CONTEXT_BYTES = 400_000;

/** A finding plus our decision on whether it clears the severity gate. */
export interface GatedFinding extends Finding {
  /** True when the finding is at or above {@link SEVERITY_THRESHOLD}. */
  shouldPost: boolean;
}

/** The whole outcome of reviewing one pull request. */
export interface ReviewResult {
  /**
   * Every finding the model returned, each carrying its post/no-post decision.
   * An empty array is a valid, handled result — a clean pull request.
   */
  findings: GatedFinding[];
  /**
   * True when the pull request was too big to send in full: the diff went out
   * but some file contents were left out. An honest partial pass, not a silent
   * truncation.
   */
  partial: boolean;
  /** Which model produced the findings (default or fallback). */
  model: string;
  /** The prompt version that produced the findings, for later storage. */
  promptVersion: string;
}

export interface ReviewDeps {
  github: GitHubClient;
  claude: ReviewModel;
  logger?: Logger;
  /**
   * Post findings at or above this severity; below it a finding is kept but not
   * shown. Defaults to {@link SEVERITY_THRESHOLD}. The GitHub Action exposes this
   * as its `min-severity` input, so a user can make the bot quieter or louder
   * without touching code.
   */
  minSeverity?: Severity;
  /** Override the size cap — tests use this to exercise the partial path. */
  maxContextBytes?: number;
  /**
   * Review only this change instead of the whole pull request. Incremental
   * re-review (ticket 05) passes the diff and file list of the newest push, so
   * the model sees just the newly-changed hunks; file contents are still read at
   * the pull request's head. Omitted on the first review, which reads the whole
   * pull request as before.
   */
  changeSet?: { diff: string; changedFiles: ChangedFile[] };
}

/**
 * Choose which changed files fit under the size cap. The diff is always sent in
 * full; file contents are added whole until the budget runs out. If any file is
 * left out, the pass is partial.
 */
function selectFiles(
  diff: string,
  files: ReviewFile[],
  maxContextBytes: number,
): { included: ReviewFile[]; partial: boolean } {
  let budget = maxContextBytes - diff.length;
  const included: ReviewFile[] = [];
  let partial = false;

  for (const file of files) {
    if (budget - file.contents.length < 0) {
      // Dropping this file rather than cutting it in half keeps the pass honest.
      partial = true;
      continue;
    }
    included.push(file);
    budget -= file.contents.length;
  }

  return { included, partial };
}

/**
 * Review one pull request. This is the single seam for the service: its
 * collaborators — the GitHub client and the Claude client — are injected, so
 * tests drive it with fakes and assert on the findings it produces.
 *
 * It fetches the diff and the full text of every changed file, sends both to
 * Claude, applies the severity gate in our own code, and returns the findings.
 * It does not post or store anything yet — that is a later ticket. Draft pull
 * requests produce an empty, non-partial result.
 */
export async function reviewPullRequest(
  pr: PullRequestContext,
  deps: ReviewDeps,
): Promise<ReviewResult> {
  const logger = deps.logger ?? noopLogger;
  const maxContextBytes = deps.maxContextBytes ?? MAX_CONTEXT_BYTES;
  const prMeta = { owner: pr.owner, repo: pr.repo, pullNumber: pr.pullNumber };

  if (pr.isDraft) {
    logger.info("Ignoring draft pull request", prMeta);
    return {
      findings: [],
      partial: false,
      model: "",
      promptVersion: PROMPT_VERSION,
    };
  }

  // An incremental re-review supplies the newest push's diff and file list; the
  // first review reads the whole pull request. Either way, file contents below
  // are read at the head, so the model sees the current text of what changed.
  const [diff, changedFiles] = deps.changeSet
    ? [deps.changeSet.diff, deps.changeSet.changedFiles]
    : await Promise.all([
        deps.github.getPullRequestDiff(prMeta),
        deps.github.listChangedFiles(prMeta),
      ]);

  // Removed files have no current text to fetch — the diff already shows what
  // went. Everything else we read at the pull request's head.
  const readable = changedFiles.filter((file) => file.status !== "removed");
  const files: ReviewFile[] = await Promise.all(
    readable.map(async (file) => ({
      path: file.filename,
      contents: await deps.github.getFileContents({
        owner: pr.owner,
        repo: pr.repo,
        path: file.filename,
        ref: pr.headSha,
      }),
    })),
  );

  const { included, partial } = selectFiles(diff, files, maxContextBytes);

  const response = await deps.claude.review({
    diff,
    files: included,
    promptVersion: PROMPT_VERSION,
  });

  const threshold = deps.minSeverity ?? SEVERITY_THRESHOLD;
  const findings: GatedFinding[] = response.findings.map((finding) => ({
    ...finding,
    shouldPost: SEVERITY_RANK[finding.severity] >= SEVERITY_RANK[threshold],
  }));

  const postable = findings.filter((finding) => finding.shouldPost).length;
  logger.info("Produced review findings", {
    ...prMeta,
    total: findings.length,
    postable,
    partial,
    model: response.model,
    promptVersion: PROMPT_VERSION,
  });

  return {
    findings,
    partial,
    model: response.model,
    promptVersion: PROMPT_VERSION,
  };
}
