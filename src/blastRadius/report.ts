import type { BlastRadiusResult, Verdict } from "./rules.js";

/** The name of the check run PostDev writes on the pull request's head commit. */
export const CHECK_NAME = "PostDev blast radius";

/** Hidden marker that identifies PostDev's one sticky blast-radius comment. */
export const COMMENT_MARKER = "<!-- postdev:blast-radius -->";

/** The label PostDev sets for each verdict, so a person can filter by it. */
export const VERDICT_LABELS: Record<Verdict, string> = {
  auto: "blast:auto",
  review: "blast:review",
  human: "blast:human",
};

const HEADLINES: Record<Verdict, string> = {
  auto: "auto: low blast radius, safe to merge once CI is green",
  review: "review: core change too large to auto-merge",
  human: "human: touches high-risk code, needs a person",
};

/**
 * The check run's title. It always starts with the verdict word, so an agent can
 * read the verdict with one API call: `output.title` before the first colon.
 */
export function checkTitle(result: BlastRadiusResult): string {
  return HEADLINES[result.verdict];
}

/** Markdown body shared by the check run summary and the sticky comment. */
export function renderSummary(result: BlastRadiusResult, notes: readonly string[] = []): string {
  const lines = [
    `**Verdict: \`${result.verdict}\`**: ${HEADLINES[result.verdict].split(": ")[1]}`,
    "",
    ...result.reasons.map((r) => `- ${r}`),
  ];
  if (notes.length > 0) {
    lines.push("", ...notes.map((n) => `> ${n}`));
  }
  const byTier = (["high", "medium", "low"] as const)
    .map((tier) => [tier, result.files.filter((f) => f.tier === tier)] as const)
    .filter(([, files]) => files.length > 0);
  if (byTier.length > 0) {
    lines.push("", "<details><summary>Files by tier</summary>", "");
    for (const [tier, files] of byTier) {
      lines.push(`**${tier}** (${files.length})`, "");
      for (const f of files.slice(0, 50)) {
        lines.push(`- \`${f.path}\` +${f.additions}/-${f.deletions}: ${f.why}`);
      }
      if (files.length > 50) lines.push(`- and ${files.length - 50} more`);
      lines.push("");
    }
    lines.push("</details>");
  }
  lines.push(
    "",
    `<sub>verdict: ${result.verdict}. Agents: merge only when this says \`auto\`, it ran on the current head commit, and all other checks are green.</sub>`,
  );
  return lines.join("\n");
}

/** The sticky comment: the summary under a hidden marker PostDev finds again. */
export function renderComment(result: BlastRadiusResult, notes: readonly string[] = []): string {
  return `${COMMENT_MARKER}\n### PostDev blast radius\n\n${renderSummary(result, notes)}`;
}
