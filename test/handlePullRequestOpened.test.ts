import { describe, expect, it } from "vitest";
import type { GitHubClient, PullRequestContext } from "../src/github/client.js";
import {
  PLACEHOLDER_COMMENT_BODY,
  handlePullRequestOpened,
} from "../src/review/handlePullRequestOpened.js";

interface PostedComment {
  owner: string;
  repo: string;
  pullNumber: number;
  body: string;
}

/** A fake GitHub client that records what the bot tried to post. */
function fakeGitHub(): { client: GitHubClient; posted: PostedComment[] } {
  const posted: PostedComment[] = [];
  const client: GitHubClient = {
    async postIssueComment(params) {
      posted.push(params);
    },
  };
  return { client, posted };
}

function prContext(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    owner: "constant-eng",
    repo: "widgets",
    pullNumber: 42,
    isDraft: false,
    headSha: "abc123",
    ...overrides,
  };
}

describe("handlePullRequestOpened", () => {
  it("posts the placeholder comment on a non-draft pull request", async () => {
    const { client, posted } = fakeGitHub();

    await handlePullRequestOpened(prContext(), { github: client });

    expect(posted).toEqual([
      {
        owner: "constant-eng",
        repo: "widgets",
        pullNumber: 42,
        body: PLACEHOLDER_COMMENT_BODY,
      },
    ]);
  });

  it("does nothing for a draft pull request", async () => {
    const { client, posted } = fakeGitHub();

    await handlePullRequestOpened(prContext({ isDraft: true }), { github: client });

    expect(posted).toEqual([]);
  });
});
