import type { InstallationOctokit } from "../github/client.js";
import type { ChangedPath } from "./rules.js";
import type { BlastRadiusGitHub } from "./runBlastRadius.js";

const PAGE = 100;
/** GitHub lists at most 3,000 files for one pull request. */
const MAX_PAGES = 30;

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: number }).status
    : undefined;
}

/** Build the blast-radius check's GitHub slice over an authenticated Octokit. */
export function createBlastRadiusGitHub(octokit: InstallationOctokit): BlastRadiusGitHub {
  return {
    async getFileText({ owner, repo, path, ref }) {
      try {
        const response = await octokit.request("GET /repos/{owner}/{repo}/contents/{path}", {
          owner,
          repo,
          path,
          ref,
          mediaType: { format: "raw" },
        });
        return response.data as unknown as string;
      } catch (error) {
        if (status(error) === 404) return null;
        throw error;
      }
    },

    async listChangedFiles({ owner, repo, pullNumber }) {
      // Every page, not just the first: a high-risk file on page two must still count.
      const files: ChangedPath[] = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await octokit.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
          { owner, repo, pull_number: pullNumber, per_page: PAGE, page },
        );
        for (const file of response.data) {
          files.push({
            path: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            ...(file.previous_filename ? { previousPath: file.previous_filename } : {}),
          });
        }
        if (response.data.length < PAGE) break;
      }
      return files;
    },

    async createCheckRun({ owner, repo, headSha, name, conclusion, title, summary }) {
      await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
        owner,
        repo,
        name,
        head_sha: headSha,
        status: "completed",
        conclusion,
        output: { title, summary: summary.slice(0, 65_000) },
      });
    },

    async upsertComment({ owner, repo, pullNumber, marker, body }) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await octokit.request(
          "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
          { owner, repo, issue_number: pullNumber, per_page: PAGE, page },
        );
        const existing = response.data.find((c) => c.body?.includes(marker));
        if (existing) {
          await octokit.request("PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}", {
            owner,
            repo,
            comment_id: existing.id,
            body,
          });
          return;
        }
        if (response.data.length < PAGE) break;
      }
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/comments", {
        owner,
        repo,
        issue_number: pullNumber,
        body,
      });
    },

    async setLabels({ owner, repo, pullNumber, add, remove }) {
      for (const name of remove) {
        try {
          await octokit.request(
            "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
            { owner, repo, issue_number: pullNumber, name },
          );
        } catch (error) {
          if (status(error) !== 404) throw error;
        }
      }
      await octokit.request("POST /repos/{owner}/{repo}/issues/{issue_number}/labels", {
        owner,
        repo,
        issue_number: pullNumber,
        labels: [add],
      });
    },
  };
}
