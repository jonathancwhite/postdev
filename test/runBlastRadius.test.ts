import { describe, expect, it } from "vitest";
import { blastRadiusTargetFromEvent } from "../src/action/reviewEvent.js";
import { CHECK_NAME, COMMENT_MARKER } from "../src/blastRadius/report.js";
import type { ChangedPath } from "../src/blastRadius/rules.js";
import {
  runBlastRadius,
  type BlastRadiusGitHub,
  type BlastRadiusTarget,
} from "../src/blastRadius/runBlastRadius.js";

const TARGET: BlastRadiusTarget = {
  owner: "acme",
  repo: "widgets",
  pullNumber: 7,
  headSha: "head1",
  baseSha: "base1",
  labels: [],
};

/** A fake GitHub that serves files and config, and records what PostDev publishes. */
function fakeGitHub(files: ChangedPath[], configAtBase: string | null = null) {
  const calls = {
    configReads: [] as Array<{ path: string; ref: string }>,
    checkRuns: [] as Array<Parameters<BlastRadiusGitHub["createCheckRun"]>[0]>,
    comments: [] as Array<Parameters<BlastRadiusGitHub["upsertComment"]>[0]>,
    labels: [] as Array<Parameters<BlastRadiusGitHub["setLabels"]>[0]>,
  };
  const github: BlastRadiusGitHub = {
    async getFileText({ path, ref }) {
      calls.configReads.push({ path, ref });
      return configAtBase;
    },
    async listChangedFiles() {
      return files;
    },
    async createCheckRun(params) {
      calls.checkRuns.push(params);
    },
    async upsertComment(params) {
      calls.comments.push(params);
    },
    async setLabels(params) {
      calls.labels.push(params);
    },
  };
  return { github, calls };
}

const change = (path: string, additions = 3, deletions = 1): ChangedPath => ({
  path,
  status: "modified",
  additions,
  deletions,
});

describe("runBlastRadius", () => {
  it("passes a docs-only PR with a green check, comment and blast:auto label", async () => {
    const { github, calls } = fakeGitHub([change("README.md", 500)]);
    const result = await runBlastRadius(TARGET, { github, configPath: ".github/postdev.json" });

    expect(result.verdict).toBe("auto");
    expect(calls.checkRuns).toEqual([
      expect.objectContaining({
        name: CHECK_NAME,
        headSha: "head1",
        conclusion: "success",
        title: expect.stringMatching(/^auto:/),
      }),
    ]);
    expect(calls.comments[0]?.marker).toBe(COMMENT_MARKER);
    expect(calls.comments[0]?.body).toContain("Verdict: `auto`");
    expect(calls.labels).toEqual([
      expect.objectContaining({ add: "blast:auto", remove: ["blast:review", "blast:human"] }),
    ]);
  });

  it("reads config from the base commit, never the pull request", async () => {
    const { github, calls } = fakeGitHub([change("README.md")], '{"blastRadius":{}}');
    await runBlastRadius(TARGET, { github, configPath: ".github/postdev.json" });
    expect(calls.configReads).toEqual([{ path: ".github/postdev.json", ref: "base1" }]);
  });

  it("marks a risky PR neutral, not failed, so CI stays green", async () => {
    const { github, calls } = fakeGitHub([change("packages/db/prisma/schema.prisma")]);
    const result = await runBlastRadius(TARGET, { github, configPath: ".github/postdev.json" });
    expect(result.verdict).toBe("human");
    expect(calls.checkRuns[0]).toMatchObject({ conclusion: "neutral", title: expect.stringMatching(/^human:/) });
  });

  it("fails closed when the config is broken", async () => {
    const { github, calls } = fakeGitHub([change("README.md")], "{oops");
    const result = await runBlastRadius(TARGET, { github, configPath: ".github/postdev.json" });
    expect(result.verdict).toBe("human");
    expect(calls.comments[0]?.body).toContain("fails closed");
  });

  it("fails closed when GitHub lists fewer files than the PR changed", async () => {
    const { github } = fakeGitHub([change("README.md")]);
    const result = await runBlastRadius(
      { ...TARGET, changedFileCount: 3001 },
      { github, configPath: ".github/postdev.json" },
    );
    expect(result.verdict).toBe("human");
    expect(result.reasons[0]).toContain("1 of 3001");
  });

  it("uses importer counts when the repo is checked out", async () => {
    const { github } = fakeGitHub([change("src/components/button.tsx", 2, 2)]);
    const result = await runBlastRadius(TARGET, {
      github,
      configPath: ".github/postdev.json",
      countImporters: async () => new Map([["src/components/button.tsx", 40]]),
    });
    expect(result.files[0]?.why).toBe("imported by 40 files");
  });

  it("notes when fan-out could not run and skips labels when asked", async () => {
    const { github, calls } = fakeGitHub([change("src/x.ts")]);
    await runBlastRadius(TARGET, { github, configPath: ".github/postdev.json", labels: false });
    expect(calls.comments[0]?.body).toContain("not checked out");
    expect(calls.labels).toEqual([]);
  });
});

describe("blastRadiusTargetFromEvent", () => {
  const payload = {
    action: "labeled",
    pull_request: {
      number: 7,
      draft: true,
      head: { sha: "head1" },
      base: { sha: "base1" },
      labels: [{ name: "needs-human" }],
      changed_files: 12,
    },
  };

  it("includes drafts and label changes, and carries labels and the file count", () => {
    expect(blastRadiusTargetFromEvent("pull_request", payload, { owner: "acme", repo: "widgets" })).toEqual({
      ...TARGET,
      labels: ["needs-human"],
      changedFileCount: 12,
    });
  });

  it("ignores other events and actions", () => {
    expect(blastRadiusTargetFromEvent("push", payload, { owner: "a", repo: "b" })).toBeNull();
    expect(
      blastRadiusTargetFromEvent("pull_request", { ...payload, action: "closed" }, { owner: "a", repo: "b" }),
    ).toBeNull();
  });
});
