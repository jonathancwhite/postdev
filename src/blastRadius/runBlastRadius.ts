import type { Logger } from "../review/handlePullRequestOpened.js";
import { BlastRadiusConfigError, loadBlastRadiusConfig } from "./config.js";
import {
  CHECK_NAME,
  COMMENT_MARKER,
  VERDICT_LABELS,
  checkTitle,
  renderComment,
  renderSummary,
} from "./report.js";
import { classifyChange, type BlastRadiusResult, type ChangedPath } from "./rules.js";

/** The pull request the blast radius is worked out for. */
export interface BlastRadiusTarget {
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  /** The base branch commit. Config is read from here, never from the PR. */
  baseSha: string;
  labels: string[];
  /** How many files GitHub says the pull request changes, to catch a short listing. */
  changedFileCount?: number;
}

/**
 * The narrow slice of GitHub the blast-radius check needs. Kept apart from the
 * review engine's client so adding it changes nothing for hosts that already
 * implement that one.
 */
export interface BlastRadiusGitHub {
  /** A file's text at a commit, or null when it does not exist there. */
  getFileText(params: { owner: string; repo: string; path: string; ref: string }): Promise<string | null>;
  listChangedFiles(params: { owner: string; repo: string; pullNumber: number }): Promise<ChangedPath[]>;
  createCheckRun(params: {
    owner: string;
    repo: string;
    headSha: string;
    name: string;
    conclusion: "success" | "neutral";
    title: string;
    summary: string;
  }): Promise<void>;
  /** Create or update the one comment whose body contains `marker`. */
  upsertComment(params: { owner: string; repo: string; pullNumber: number; marker: string; body: string }): Promise<void>;
  /** Add `add` and remove any of `remove` the pull request carries. */
  setLabels(params: { owner: string; repo: string; pullNumber: number; add: string; remove: string[] }): Promise<void>;
}

export interface RunBlastRadiusDeps {
  github: BlastRadiusGitHub;
  /** Repo path of the config file, read at the base commit. */
  configPath: string;
  /**
   * Counts of direct importers per file, from the checked-out repo. Called only
   * when the config leaves fan-out on. Omit when the repo is not checked out.
   */
  countImporters?: () => Promise<Map<string, number>>;
  /** Set the verdict labels on the pull request. */
  labels?: boolean;
  logger?: Logger;
}

const noopLogger: Logger = { info() {} };

/**
 * Work out a pull request's blast radius and publish it three ways: a check run
 * on the head commit (success for `auto`, neutral otherwise, so CI stays green
 * either way), one sticky comment, and a `blast:*` label. Config always comes
 * from the base commit, so a pull request cannot loosen its own gate. A broken
 * config fails closed: the verdict is `human` and the comment says why.
 */
export async function runBlastRadius(
  target: BlastRadiusTarget,
  deps: RunBlastRadiusDeps,
): Promise<BlastRadiusResult> {
  const logger = deps.logger ?? noopLogger;
  const { owner, repo, pullNumber } = target;
  const notes: string[] = [];

  const files = await deps.github.listChangedFiles({ owner, repo, pullNumber });
  const configText = await deps.github.getFileText({
    owner,
    repo,
    path: deps.configPath,
    ref: target.baseSha,
  });

  let result: BlastRadiusResult;
  try {
    const config = loadBlastRadiusConfig(configText);
    if (configText === null) {
      notes.push(`No \`${deps.configPath}\` on the base branch, so PostDev's built-in rules were used.`);
    }
    let importers = new Map<string, number>();
    if (config.fanout && deps.countImporters) {
      importers = await deps.countImporters();
    } else if (config.fanout) {
      notes.push("The repo was not checked out, so widely imported files were not detected.");
    }
    result = classifyChange(files, config, importers, target.labels);
    if (target.changedFileCount !== undefined && files.length < target.changedFileCount) {
      // GitHub lists at most 3,000 files. Any we could not see might be high risk.
      result = {
        ...result,
        verdict: "human",
        reasons: [
          `GitHub listed ${files.length} of ${target.changedFileCount} changed files, so the rest could not be checked`,
          ...result.reasons.filter((r) => !r.startsWith("only low-risk") && !r.startsWith("small core change")),
        ],
      };
    }
  } catch (error) {
    if (!(error instanceof BlastRadiusConfigError)) throw error;
    result = {
      verdict: "human",
      reasons: [`PostDev's config could not be read, so this fails closed: ${error.message}`],
      files: [],
      coreLines: 0,
    };
  }
  logger.info("Blast radius worked out", {
    owner,
    repo,
    pullNumber,
    verdict: result.verdict,
    files: files.length,
  });

  await deps.github.createCheckRun({
    owner,
    repo,
    headSha: target.headSha,
    name: CHECK_NAME,
    conclusion: result.verdict === "auto" ? "success" : "neutral",
    title: checkTitle(result),
    summary: renderSummary(result, notes),
  });
  await deps.github.upsertComment({
    owner,
    repo,
    pullNumber,
    marker: COMMENT_MARKER,
    body: renderComment(result, notes),
  });
  if (deps.labels ?? true) {
    const add = VERDICT_LABELS[result.verdict];
    await deps.github.setLabels({
      owner,
      repo,
      pullNumber,
      add,
      remove: Object.values(VERDICT_LABELS).filter((l) => l !== add),
    });
  }
  return result;
}
