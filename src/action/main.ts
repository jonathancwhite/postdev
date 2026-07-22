import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import Anthropic from "@anthropic-ai/sdk";
import {
  createBotCommentReader,
  createGitHubClient,
  type ChangedFile,
  type InstallationOctokit,
} from "../github/client.js";
import { createAnthropicModel, type Severity } from "../model/reviewModel.js";
import { createGitHubPostedFindingsStore } from "../store/postedFindingsStore.js";
import { runReview } from "../review/runReview.js";
import type { Logger } from "../review/handlePullRequestOpened.js";
import { reviewTargetFromEvent } from "./reviewEvent.js";

/**
 * The open-source Action defaults to a cheaper model than the engine's own
 * default, so wiring the bot to a busy personal repo does not produce a
 * surprising bill. A user opts up to a stronger model with the `model` input.
 */
const DEFAULT_ACTION_MODEL = "claude-sonnet-5";

const SEVERITIES: readonly Severity[] = ["low", "medium", "high", "critical"];

function parseSeverity(raw: string): Severity | undefined {
  return (SEVERITIES as readonly string[]).includes(raw)
    ? (raw as Severity)
    : undefined;
}

/** Route the engine's structured logs to the Action's own log stream. */
const logger: Logger = {
  info(message, meta) {
    core.info(meta ? `${message} ${JSON.stringify(meta)}` : message);
  },
};

/**
 * The GitHub Action front door. It sources what to review from the Action event,
 * builds the engine's injected collaborators from the workflow's inputs and the
 * built-in token, and hands off to the same `runReview` seam the webhook host
 * uses. All the review behaviour lives down in the engine; this only wires it.
 */
export async function main(): Promise<void> {
  const target = reviewTargetFromEvent(
    context.eventName,
    context.payload,
    context.repo,
  );
  if (!target) {
    core.info("No pull request to review for this event.");
    return;
  }

  // The model key is read from the environment, never an input, so it is never
  // committed and never printed in a workflow file. The example workflow sets it
  // from a repository secret.
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    core.setFailed(
      "ANTHROPIC_API_KEY is not set. Pass it via `env` from a repository secret — see the configuration guide.",
    );
    return;
  }

  const token = core.getInput("github-token");
  if (!token) {
    core.setFailed("The `github-token` input is required.");
    return;
  }

  const model = core.getInput("model") || DEFAULT_ACTION_MODEL;
  const fallbackModel = core.getInput("fallback-model") || DEFAULT_ACTION_MODEL;
  const botLogin = core.getInput("bot-login") || "github-actions[bot]";

  const minSeverity = parseSeverity(core.getInput("min-severity") || "medium");
  if (!minSeverity) {
    core.setFailed(
      `min-severity must be one of: ${SEVERITIES.join(", ")}.`,
    );
    return;
  }

  // `getOctokit` returns an Octokit that is structurally the installation client
  // the engine expects; the cast records that at this one boundary.
  const octokit = getOctokit(token) as unknown as InstallationOctokit;
  const github = createGitHubClient(octokit);
  const claude = createAnthropicModel(new Anthropic({ apiKey }), {
    model,
    fallbackModel,
  });
  const postedFindings = createGitHubPostedFindingsStore(
    createBotCommentReader(octokit),
    botLogin,
  );

  // On a push, review just what changed and dedupe against comments already
  // posted; on open/reopen/ready, review the whole pull request.
  let scope: { diff: string; changedFiles: ChangedFile[] } | undefined;
  if (target.push) {
    const compared = await github.compareCommits({
      owner: target.pr.owner,
      repo: target.pr.repo,
      base: target.push.before,
      head: target.push.after,
    });
    scope = { diff: compared.diff, changedFiles: compared.files };
  }

  await runReview(target.pr, {
    github,
    claude,
    postedFindings,
    minSeverity,
    logger,
    scope,
  });
  core.info("PostDev review complete.");
}

main().catch((error) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
