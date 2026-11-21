import { existsSync } from "node:fs";
import { join } from "node:path";
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
import { blastRadiusTargetFromEvent, reviewTargetFromEvent } from "./reviewEvent.js";
import { countImporters } from "../blastRadius/importGraph.js";
import { createBlastRadiusGitHub } from "../blastRadius/github.js";
import { runBlastRadius } from "../blastRadius/runBlastRadius.js";

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

/** Read a true/false input, falling back when it is empty. */
function booleanInput(name: string, fallback: boolean): boolean {
  const raw = core.getInput(name).trim().toLowerCase();
  if (raw === "") return fallback;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`The \`${name}\` input must be true or false.`);
}

/**
 * The GitHub Action front door. It runs up to two independent jobs on a pull
 * request: the blast-radius check (no model key needed) and the AI review. Each
 * reads what to act on from the Action event, builds its collaborators from the
 * workflow inputs and the built-in token, and hands off to its engine seam.
 */
export async function main(): Promise<void> {
  const token = core.getInput("github-token");
  if (!token) {
    core.setFailed("The `github-token` input is required.");
    return;
  }
  const octokit = getOctokit(token) as unknown as InstallationOctokit;

  if (booleanInput("blast-radius", false)) {
    // A failed blast-radius run posts no verdict, which agents read as "needs a
    // person". It fails the job but still lets the review run.
    try {
      await blastRadius(octokit);
    } catch (error) {
      core.setFailed(
        `Blast radius: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (booleanInput("review", true)) {
    await review(octokit);
  }
}

/**
 * Work out the pull request's blast radius and publish it as a check run, a
 * sticky comment and a label. Fan-out needs the repo checked out in the
 * workspace (actions/checkout); without it the path rules still run.
 */
async function blastRadius(octokit: InstallationOctokit): Promise<void> {
  const target = blastRadiusTargetFromEvent(context.eventName, context.payload, context.repo);
  if (!target) {
    core.info("No pull request to check the blast radius of for this event.");
    return;
  }
  const workspace = process.env.GITHUB_WORKSPACE;
  const checkedOut = workspace !== undefined && existsSync(join(workspace, ".git"));
  const result = await runBlastRadius(target, {
    github: createBlastRadiusGitHub(octokit),
    configPath: core.getInput("config") || ".github/postdev.json",
    labels: booleanInput("blast-radius-labels", true),
    logger,
    ...(checkedOut ? { countImporters: () => countImporters(workspace) } : {}),
  });
  core.setOutput("blast-radius-verdict", result.verdict);
  core.info(`Blast radius: ${result.verdict}. ${result.reasons.join("; ")}`);
}

/** Review the pull request with the configured model and post the findings. */
async function review(octokit: InstallationOctokit): Promise<void> {
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
      "ANTHROPIC_API_KEY is not set. Pass it via `env` from a repository secret — see the configuration guide. To run only the blast-radius check, set `review: false`.",
    );
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
  // the engine expects; the cast in main() records that at this one boundary.
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
