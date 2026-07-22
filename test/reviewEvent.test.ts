import { describe, expect, it } from "vitest";
import {
  reviewTargetFromEvent,
  type PullRequestEventPayload,
} from "../src/action/reviewEvent.js";

const REPO = { owner: "acme", repo: "widgets" };

function prPayload(
  overrides: Partial<PullRequestEventPayload> = {},
): PullRequestEventPayload {
  return {
    action: "opened",
    pull_request: { number: 7, draft: false, head: { sha: "head1" } },
    ...overrides,
  };
}

describe("reviewTargetFromEvent", () => {
  it("builds a pull-request context from an opened event", () => {
    const target = reviewTargetFromEvent("pull_request", prPayload(), REPO);
    expect(target).toEqual({
      pr: {
        owner: "acme",
        repo: "widgets",
        pullNumber: 7,
        isDraft: false,
        headSha: "head1",
      },
    });
  });

  it("carries the push range on a synchronize so a re-review can scope to it", () => {
    const target = reviewTargetFromEvent(
      "pull_request",
      prPayload({ action: "synchronize", before: "old", after: "new" }),
      REPO,
    );
    expect(target?.push).toEqual({ before: "old", after: "new" });
    expect(target?.pr.pullNumber).toBe(7);
  });

  it("has no push range on open/reopen/ready", () => {
    for (const action of ["opened", "reopened", "ready_for_review"]) {
      const target = reviewTargetFromEvent(
        "pull_request",
        prPayload({ action }),
        REPO,
      );
      expect(target?.push).toBeUndefined();
    }
  });

  it("does not review a draft", () => {
    const target = reviewTargetFromEvent(
      "pull_request",
      prPayload({ pull_request: { number: 7, draft: true, head: { sha: "h" } } }),
      REPO,
    );
    expect(target).toBeNull();
  });

  it("ignores pull-request actions it does not act on", () => {
    for (const action of ["closed", "labeled", "assigned", "edited"]) {
      expect(
        reviewTargetFromEvent("pull_request", prPayload({ action }), REPO),
      ).toBeNull();
    }
  });

  it("ignores events that are not pull requests", () => {
    expect(reviewTargetFromEvent("push", prPayload(), REPO)).toBeNull();
    expect(reviewTargetFromEvent("issue_comment", prPayload(), REPO)).toBeNull();
  });

  it("returns null when the payload is missing a pull request or head sha", () => {
    expect(
      reviewTargetFromEvent("pull_request", { action: "opened" }, REPO),
    ).toBeNull();
    expect(
      reviewTargetFromEvent(
        "pull_request",
        { action: "opened", pull_request: { number: 7 } },
        REPO,
      ),
    ).toBeNull();
  });

  it("takes owner and repo from the repo ref, not the payload", () => {
    const target = reviewTargetFromEvent("pull_request", prPayload(), {
      owner: "someone-else",
      repo: "their-fork",
    });
    expect(target?.pr.owner).toBe("someone-else");
    expect(target?.pr.repo).toBe("their-fork");
  });
});
