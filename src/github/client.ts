import type { App } from "@octokit/app";

/** The installation-authenticated Octokit the App hands to webhook handlers. */
export type InstallationOctokit = Awaited<
  ReturnType<App["getInstallationOctokit"]>
>;

/**
 * The bot's view of a pull request it has been asked to act on. Kept small and
 * plain so the webhook adapter can build one from a raw payload and tests can
 * build one by hand.
 */
export interface PullRequestContext {
  owner: string;
  repo: string;
  pullNumber: number;
  /** Draft pull requests are ignored — the bot reviews finished intent only. */
  isDraft: boolean;
  headSha: string;
}

/**
 * What GitHub gave back for one posted review: the review's own id and, for each
 * inline comment it created, the id GitHub assigned it matched to the file and
 * line it sits on. The training store uses these to tie a stored finding to the
 * exact comment a reviewer sees, so a later human reply can be mirrored back.
 */
export interface CreatedReview {
  /** The id GitHub assigned the review. */
  reviewId: number;
  /** Each inline comment GitHub created, with its assigned id, file and line. */
  comments: Array<{ path: string; line: number; id: number }>;
}

/** One file changed by a pull request, as GitHub's "list files" endpoint reports it. */
export interface ChangedFile {
  filename: string;
  /** "added" | "modified" | "removed" | "renamed" | "changed" | "copied". */
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

/**
 * The narrow slice of GitHub the bot needs. Real code wraps an installation
 * Octokit; tests supply a fake and assert on what the bot tried to post or read.
 * The review engine (ticket 02) added the three read methods; later tickets add
 * inline review comments without changing how this is injected.
 */
export interface GitHubClient {
  /** Post a conversation-level comment on a pull request, as the bot identity. */
  postIssueComment(params: {
    owner: string;
    repo: string;
    pullNumber: number;
    body: string;
  }): Promise<void>;

  /**
   * Post one COMMENT-type review carrying a summary body and any number of
   * inline comments, each anchored to a file and a line on the diff's new side.
   * A COMMENT review is advisory — it never approves, never requests changes,
   * and never blocks a merge. `comments` may be empty for a summary-only review.
   * Returns the created review and comment identities so the caller can record
   * what was posted.
   */
  createReview(params: {
    owner: string;
    repo: string;
    pullNumber: number;
    /** The head commit the inline lines are numbered against. */
    commitSha: string;
    /** The summary comment shown at the top of the review. */
    body: string;
    comments: Array<{ path: string; line: number; body: string }>;
  }): Promise<CreatedReview>;

  /**
   * The current state of one pull request. The mention trigger (ticket 06)
   * arrives on an `issue_comment` event that carries no head SHA, so it reads
   * the head to review and the draft flag back from here.
   */
  getPullRequest(params: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<{ headSha: string; isDraft: boolean }>;

  /** The whole pull request as a unified diff. */
  getPullRequestDiff(params: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<string>;

  /** Every file the pull request changed. */
  listChangedFiles(params: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<ChangedFile[]>;

  /**
   * The change between two commits — the unified diff and the files it touched.
   * Incremental re-review (ticket 05) compares the pull request's previous head
   * against its new head after a push, so it reviews only the newly-changed
   * hunks rather than the whole pull request again.
   */
  compareCommits(params: {
    owner: string;
    repo: string;
    /** The commit to compare from — the pull request's previous head. */
    base: string;
    /** The commit to compare to — the pull request's new head. */
    head: string;
  }): Promise<{ diff: string; files: ChangedFile[] }>;

  /** The full text of one file at a given commit. */
  getFileContents(params: {
    owner: string;
    repo: string;
    path: string;
    ref: string;
  }): Promise<string>;
}

/** One comment or review body the bot may have written, with who wrote it. */
export interface PostedCommentBody {
  /** The login of whoever wrote it, or null when the source names none. */
  author: string | null;
  body: string;
}

/**
 * A read of the bot's own prior comments on a pull request. Kept separate from
 * {@link GitHubClient} on purpose: the review flow never needs it, so its many
 * test fakes do not carry it. Only the open-source dedupe store depends on this
 * — it rebuilds the set of fingerprints already posted from the bot's comments,
 * so cross-push dedupe works from a stateless run with no database behind it.
 */
export interface BotCommentReader {
  /** Every inline review comment on a pull request, with its author and body. */
  listReviewComments(params: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<PostedCommentBody[]>;

  /** Every review on a pull request — the summary bodies — with author and body. */
  listReviews(params: {
    owner: string;
    repo: string;
    pullNumber: number;
  }): Promise<PostedCommentBody[]>;
}

/**
 * Build a {@link BotCommentReader} over the same Octokit the client uses. The
 * open-source dedupe store reads the bot's prior inline comments and review
 * summaries through this, then extracts the fingerprint markers they carry.
 */
export function createBotCommentReader(
  octokit: InstallationOctokit,
): BotCommentReader {
  return {
    async listReviewComments({ owner, repo, pullNumber }) {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        { owner, repo, pull_number: pullNumber, per_page: 100 },
      );
      return response.data.map((comment) => ({
        author: comment.user?.login ?? null,
        body: comment.body ?? "",
      }));
    },

    async listReviews({ owner, repo, pullNumber }) {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        { owner, repo, pull_number: pullNumber, per_page: 100 },
      );
      return response.data.map((review) => ({
        author: review.user?.login ?? null,
        body: review.body ?? "",
      }));
    },
  };
}

/**
 * Build a {@link GitHubClient} backed by an installation-authenticated Octokit.
 * Because the Octokit is authenticated as the App installation, everything it
 * posts appears under the bot account.
 */
export function createGitHubClient(octokit: InstallationOctokit): GitHubClient {
  return {
    async postIssueComment({ owner, repo, pullNumber, body }) {
      // A pull request is an issue for comment purposes, so a conversation-level
      // comment goes through the issues endpoint.
      await octokit.request(
        "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
        { owner, repo, issue_number: pullNumber, body },
      );
    },

    async createReview({ owner, repo, pullNumber, commitSha, body, comments }) {
      // `event: "COMMENT"` keeps the review advisory — the inline comments and
      // the summary body post together as one review that never gates merge.
      // `side: "RIGHT"` anchors each comment to the new side of the diff.
      const created = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: commitSha,
          event: "COMMENT",
          body,
          comments: comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: "RIGHT",
            body: comment.body,
          })),
        },
      );

      const reviewId = created.data.id;

      // The create-review response does not carry the per-comment ids, so read
      // them back once the review exists. Each comment's id, path, and new-side
      // line let the caller tie a stored finding to the comment a reviewer sees.
      // A summary-only review has nothing to read back.
      let postedComments: CreatedReview["comments"] = [];
      if (comments.length > 0) {
        const listed = await octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments",
          { owner, repo, pull_number: pullNumber, review_id: reviewId },
        );
        postedComments = listed.data.map((comment) => ({
          path: comment.path,
          // GitHub returns the new-side line as `line`; older payloads use
          // `original_line`. Fall back so a match is still possible.
          line: comment.line ?? comment.original_line ?? 0,
          id: comment.id,
        }));
      }

      return { reviewId, comments: postedComments };
    },

    async getPullRequest({ owner, repo, pullNumber }) {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner, repo, pull_number: pullNumber },
      );
      return {
        headSha: response.data.head.sha,
        isDraft: response.data.draft ?? false,
      };
    },

    async getPullRequestDiff({ owner, repo, pullNumber }) {
      // The `diff` media type makes GitHub return the raw unified diff as text
      // rather than the usual JSON pull-request object.
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        {
          owner,
          repo,
          pull_number: pullNumber,
          mediaType: { format: "diff" },
        },
      );
      // With the diff media type the body is a string; the types still say the
      // JSON shape, so we assert through unknown.
      return response.data as unknown as string;
    },

    async listChangedFiles({ owner, repo, pullNumber }) {
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
        { owner, repo, pull_number: pullNumber, per_page: 100 },
      );
      return response.data.map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));
    },

    async compareCommits({ owner, repo, base, head }) {
      const basehead = `${base}...${head}`;
      // Two reads of the same compare: the `diff` media type returns the raw
      // unified diff as text, while the default JSON carries the per-file list
      // the review engine reads at head. GitHub caps compare at 300 files —
      // enough for a single push's worth of changes.
      const [diffResponse, filesResponse] = await Promise.all([
        octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          owner,
          repo,
          basehead,
          mediaType: { format: "diff" },
        }),
        octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
          owner,
          repo,
          basehead,
        }),
      ]);

      const files = (filesResponse.data.files ?? []).map((file) => ({
        filename: file.filename,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
      }));

      return { diff: diffResponse.data as unknown as string, files };
    },

    async getFileContents({ owner, repo, path, ref }) {
      // The `raw` media type returns the file's bytes directly instead of the
      // base64-in-JSON contents object.
      const response = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner, repo, path, ref, mediaType: { format: "raw" } },
      );
      return response.data as unknown as string;
    },
  };
}
