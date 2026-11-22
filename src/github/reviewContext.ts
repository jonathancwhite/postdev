import type { InstallationOctokit, PullRequestContext } from "./client.js";
import type { ReviewDocument } from "../model/reviewModel.js";

/**
 * Where the two review axes get what they measure the change against: the
 * repository's documented coding standards (Standards) and the issues the pull
 * request links to (Spec). Injected like the GitHub client, so tests supply a
 * fake and a host without it simply reviews against the smell baseline alone.
 */
export interface ReviewContextReader {
  /** The repository's documents on how code should be written. */
  standards(pr: PullRequestContext): Promise<ReviewDocument[]>;
  /** The issues the pull request links to. Empty means there is no spec. */
  spec(pr: PullRequestContext): Promise<ReviewDocument[]>;
}

/**
 * The files checked for coding standards, in the order they are given to the
 * model. CODING_STANDARDS.md and CONTRIBUTING.md always come first when present.
 */
export const STANDARDS_FILES = [
  "CODING_STANDARDS.md",
  "docs/CODING_STANDARDS.md",
  "CONTRIBUTING.md",
  ".github/CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  "CLAUDE.md",
  "AGENTS.md",
  ".github/copilot-instructions.md",
] as const;

/** Most issues read as the spec for one pull request. */
export const MAX_SPEC_ISSUES = 3;

/** Cap on each document's text, so one huge file can't crowd out the change. */
export const MAX_DOCUMENT_CHARS = 40_000;

function clip(text: string): string {
  return text.length > MAX_DOCUMENT_CHARS
    ? `${text.slice(0, MAX_DOCUMENT_CHARS)}\n[...cut at ${MAX_DOCUMENT_CHARS} characters]`
    : text;
}

/**
 * The issue numbers a pull request's text points at, in first-seen order:
 * `#123`, `Closes #45`, `owner/repo#7` and full issue links, for this repository
 * only. The pull request's own number is left out.
 */
export function findIssueReferences(
  texts: string[],
  owner: string,
  repo: string,
  selfNumber: number,
): number[] {
  const seen = new Set<number>();
  const ownerRepo = `${owner}/${repo}`.toLowerCase();
  const add = (n: number) => {
    if (n > 0 && n !== selfNumber) seen.add(n);
  };
  // Escape the repository name for use inside a pattern.
  const escaped = ownerRepo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const link = new RegExp(
    `https?://github\\.com/${escaped}/issues/(\\d+)`,
    "gi",
  );
  const crossRef = /([\w.-]+\/[\w.-]+)#(\d+)\b/g;
  const bare = /(^|[^\w/#&])#(\d+)\b/g;

  for (const text of texts) {
    for (const match of text.matchAll(link)) add(Number(match[1]));
    for (const match of text.matchAll(crossRef)) {
      if (match[1]!.toLowerCase() === ownerRepo) add(Number(match[2]));
    }
    for (const match of text.matchAll(bare)) add(Number(match[2]));
  }
  return [...seen];
}

/**
 * The real {@link ReviewContextReader}, backed by an installation Octokit.
 * Standards are read at the pull request's base, so a pull request can't
 * rewrite the rules it is reviewed against. The spec is every issue the pull
 * request's title, body, or commit messages reference, read through the issues
 * API; references to other pull requests are skipped.
 */
export function createReviewContextReader(
  octokit: InstallationOctokit,
): ReviewContextReader {
  return {
    async standards({ owner, repo, pullNumber }) {
      const pull = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner, repo, pull_number: pullNumber },
      );
      const ref = pull.data.base.sha;
      const docs: ReviewDocument[] = [];
      for (const path of STANDARDS_FILES) {
        try {
          const response = await octokit.request(
            "GET /repos/{owner}/{repo}/contents/{path}",
            { owner, repo, path, ref, mediaType: { format: "raw" } },
          );
          const text = response.data as unknown as string;
          if (typeof text === "string" && text.trim()) {
            docs.push({ source: path, text: clip(text) });
          }
        } catch {
          // Not in this repository: try the next candidate.
        }
      }
      return docs;
    },

    async spec({ owner, repo, pullNumber }) {
      const [pull, commits] = await Promise.all([
        octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
          owner,
          repo,
          pull_number: pullNumber,
        }),
        octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}/commits", {
          owner,
          repo,
          pull_number: pullNumber,
          per_page: 100,
        }),
      ]);
      const texts = [
        pull.data.title,
        pull.data.body ?? "",
        ...commits.data.map((commit) => commit.commit.message),
      ];
      const numbers = findIssueReferences(texts, owner, repo, pullNumber);

      const docs: ReviewDocument[] = [];
      for (const number of numbers) {
        if (docs.length >= MAX_SPEC_ISSUES) break;
        try {
          const issue = await octokit.request(
            "GET /repos/{owner}/{repo}/issues/{issue_number}",
            { owner, repo, issue_number: number },
          );
          // The issues API also returns pull requests; those aren't a spec.
          if (issue.data.pull_request) continue;
          docs.push({
            source: `issue #${number}`,
            text: clip(`# ${issue.data.title}\n\n${issue.data.body ?? ""}`),
          });
        } catch {
          // Deleted, transferred, or out of reach: review without it.
        }
      }
      return docs;
    },
  };
}
