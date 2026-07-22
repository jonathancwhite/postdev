import type { GitHubClient, PullRequestContext } from "../github/client.js";

/**
 * The fixed placeholder the tracer-bullet build posts. It carries no review
 * content — its only job is to prove, visibly, that the bot is installed,
 * authenticated, and able to comment. Real findings replace it in ticket 03.
 */
export const PLACEHOLDER_COMMENT_BODY = [
  "🔍 **PostDev** is watching this pull request.",
  "",
  "This is a placeholder — automated review is not switched on yet. Seeing this",
  "comment means the bot is installed and can post under its own account.",
].join("\n");

export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
}

const noopLogger: Logger = { info() {} };

/**
 * Act on a freshly opened pull request. Draft pull requests produce no action;
 * every other pull request gets the placeholder comment.
 *
 * This is the one seam for the service: its collaborator — the GitHub client —
 * is injected, so tests drive it with a fake and assert on what it tried to
 * post. Later tickets add the Claude client and the store as further injected
 * collaborators here.
 */
export async function handlePullRequestOpened(
  pr: PullRequestContext,
  deps: { github: GitHubClient; logger?: Logger },
): Promise<void> {
  const logger = deps.logger ?? noopLogger;
  const prMeta = { owner: pr.owner, repo: pr.repo, pullNumber: pr.pullNumber };

  if (pr.isDraft) {
    logger.info("Ignoring draft pull request", prMeta);
    return;
  }

  await deps.github.postIssueComment({
    ...prMeta,
    body: PLACEHOLDER_COMMENT_BODY,
  });

  logger.info("Posted placeholder comment", prMeta);
}
