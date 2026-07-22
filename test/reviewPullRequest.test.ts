import { describe, expect, it } from "vitest";
import type {
  ChangedFile,
  GitHubClient,
  PullRequestContext,
} from "../src/github/client.js";
import type {
  ReviewModel,
  Finding,
  ReviewRequest,
} from "../src/model/reviewModel.js";
import { PROMPT_VERSION } from "../src/model/reviewModel.js";
import { reviewPullRequest } from "../src/review/reviewPullRequest.js";

interface FakeGitHubOptions {
  diff?: string;
  changedFiles?: ChangedFile[];
  fileContents?: Record<string, string>;
}

function changed(
  filename: string,
  status: ChangedFile["status"] = "modified",
): ChangedFile {
  return { filename, status, additions: 1, deletions: 0, changes: 1 };
}

/** A fake GitHub client that serves canned diff, file list, and file text. */
function fakeGitHub(options: FakeGitHubOptions = {}): GitHubClient {
  const contents = options.fileContents ?? {};
  return {
    async postIssueComment() {},
    async getPullRequestDiff() {
      return options.diff ?? "diff --git a/x b/x";
    },
    async listChangedFiles() {
      return options.changedFiles ?? [changed("x.ts")];
    },
    async getFileContents({ path }) {
      return contents[path] ?? "";
    },
  };
}

interface FakeClaude {
  client: ReviewModel;
  requests: ReviewRequest[];
}

/** A fake Claude client that records its input and returns canned findings. */
function fakeClaude(findings: Finding[], model = "claude-opus-4-8"): FakeClaude {
  const requests: ReviewRequest[] = [];
  const client: ReviewModel = {
    async review(request) {
      requests.push(request);
      return { findings, model };
    },
  };
  return { client, requests };
}

function prContext(
  overrides: Partial<PullRequestContext> = {},
): PullRequestContext {
  return {
    owner: "constant-eng",
    repo: "widgets",
    pullNumber: 42,
    isDraft: false,
    headSha: "abc123",
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    file: "x.ts",
    line: 10,
    severity: "high",
    category: "correctness",
    message: "This throws when x is null",
    confidence: 0.9,
    ...overrides,
  };
}

describe("reviewPullRequest", () => {
  it("produces no findings for a clean pull request", async () => {
    const { client } = fakeClaude([]);

    const result = await reviewPullRequest(prContext(), {
      github: fakeGitHub(),
      claude: client,
    });

    expect(result.findings).toEqual([]);
    expect(result.partial).toBe(false);
    expect(result.promptVersion).toBe(PROMPT_VERSION);
  });

  it("marks findings above the gate as postable", async () => {
    const { client } = fakeClaude([
      finding({ severity: "critical" }),
      finding({ severity: "medium" }),
      finding({ severity: "high" }),
    ]);

    const result = await reviewPullRequest(prContext(), {
      github: fakeGitHub(),
      claude: client,
    });

    expect(result.findings).toHaveLength(3);
    expect(result.findings.every((f) => f.shouldPost)).toBe(true);
  });

  it("keeps sub-threshold findings but marks them not-to-post", async () => {
    const { client } = fakeClaude([
      finding({ severity: "low", line: 1 }),
      finding({ severity: "high", line: 2 }),
    ]);

    const result = await reviewPullRequest(prContext(), {
      github: fakeGitHub(),
      claude: client,
    });

    // Both findings are kept — the store needs them — but only the high one posts.
    expect(result.findings).toHaveLength(2);
    const low = result.findings.find((f) => f.severity === "low");
    const high = result.findings.find((f) => f.severity === "high");
    expect(low?.shouldPost).toBe(false);
    expect(high?.shouldPost).toBe(true);
  });

  it("sends the diff and full file contents to Claude", async () => {
    const { client, requests } = fakeClaude([]);

    await reviewPullRequest(prContext(), {
      github: fakeGitHub({
        diff: "diff --git a/x.ts b/x.ts\n+const y = 1;",
        changedFiles: [changed("x.ts")],
        fileContents: { "x.ts": "const y = 1;\n" },
      }),
      claude: client,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.diff).toContain("const y = 1;");
    expect(requests[0]?.files).toEqual([
      { path: "x.ts", contents: "const y = 1;\n" },
    ]);
  });

  it("skips removed files when fetching contents", async () => {
    const { client, requests } = fakeClaude([]);

    await reviewPullRequest(prContext(), {
      github: fakeGitHub({
        changedFiles: [changed("kept.ts"), changed("gone.ts", "removed")],
        fileContents: { "kept.ts": "kept", "gone.ts": "should-not-appear" },
      }),
      claude: client,
    });

    expect(requests[0]?.files).toEqual([{ path: "kept.ts", contents: "kept" }]);
  });

  it("degrades an oversized pull request to an honest partial pass", async () => {
    const big = "x".repeat(50);
    const { client, requests } = fakeClaude([]);

    const result = await reviewPullRequest(prContext(), {
      github: fakeGitHub({
        diff: "d",
        changedFiles: [changed("a.ts"), changed("b.ts")],
        fileContents: { "a.ts": big, "b.ts": big },
      }),
      claude: client,
      // Budget fits the diff plus one file, not both.
      maxContextBytes: 60,
    });

    expect(result.partial).toBe(true);
    // The diff still went out with one file included — never a silent truncation.
    expect(requests[0]?.files).toHaveLength(1);
    expect(requests[0]?.diff).toBe("d");
  });

  it("does nothing for a draft pull request", async () => {
    const { client, requests } = fakeClaude([finding()]);

    const result = await reviewPullRequest(prContext({ isDraft: true }), {
      github: fakeGitHub(),
      claude: client,
    });

    expect(result.findings).toEqual([]);
    expect(result.partial).toBe(false);
    expect(requests).toEqual([]);
  });

  it("reports which model produced the findings", async () => {
    const { client } = fakeClaude([finding()], "claude-sonnet-5");

    const result = await reviewPullRequest(prContext(), {
      github: fakeGitHub(),
      claude: client,
    });

    expect(result.model).toBe("claude-sonnet-5");
  });
});
