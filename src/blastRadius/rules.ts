import { compileGlobs } from "./glob.js";

/**
 * How far a change could reach if it is wrong.
 * - `auto`: low blast radius; an agent may merge it once CI is green.
 * - `review`: core code changed beyond the small-change limit; a person looks.
 * - `human`: touches a high-risk area; a person always looks.
 */
export type Verdict = "auto" | "review" | "human";

/** The tier one changed file falls into. */
export type Tier = "high" | "medium" | "low";

/** One changed file, as GitHub's "list pull request files" reports it. */
export interface ChangedPath {
  path: string;
  /** "added" | "modified" | "removed" | "renamed" | ... */
  status: string;
  additions: number;
  deletions: number;
  /** For a rename, the path the file moved from. It is judged too. */
  previousPath?: string;
}

export interface BlastRadiusLimits {
  /** A PR auto-merges with at most this many medium-tier files... */
  coreFiles: number;
  /** ...and at most this many changed lines across them. */
  coreLines: number;
  /** A low-tier file with more direct importers than this counts as medium. */
  fanoutMedium: number;
  /** A medium-tier file with more direct importers than this counts as high. */
  fanoutHigh: number;
}

/** A repo's blast-radius rules after defaults are applied. */
export interface BlastRadiusConfig {
  high: string[];
  medium: string[];
  low: string[];
  /** File-name words that make any non-doc, non-test file high risk. Empty turns the net off. */
  keywords: string[];
  /** Paths the keyword net skips, for files whose names only look risky. */
  keywordIgnore: string[];
  /** The tier for a file no rule matches. */
  unmatched: Tier;
  limits: BlastRadiusLimits;
  /** A label a person adds to force a `human` verdict. */
  overrideLabel: string;
  /** Count importers to catch widely used files. Needs the repo checked out. */
  fanout: boolean;
}

/**
 * Built-in high-risk paths for any JS/TS repo: build, deploy and CI config,
 * dependencies, database schema and migrations, and env files. `.github/**`
 * also covers PostDev's own config, so a pull request cannot loosen its own gate.
 */
export const DEFAULT_HIGH: readonly string[] = [
  ".github/**",
  "**/Dockerfile",
  "**/Dockerfile.*",
  "**/*.Dockerfile",
  "**/docker-compose*.yml",
  "**/docker-compose*.yaml",
  "**/railway*.json",
  "**/railway*.toml",
  ".railway/**",
  "**/vercel.json",
  "**/netlify.toml",
  "**/fly.toml",
  "**/Procfile",
  "**/package.json",
  "pnpm-workspace.yaml",
  "**/.npmrc",
  "**/.nvmrc",
  "**/tsconfig*.json",
  "turbo.json",
  "nx.json",
  "**/*.sql",
  "**/migrations/**",
  "**/schema.prisma",
  "**/.env*",
  // Agent instructions and settings: they hold the merge rules this check feeds,
  // so an agent must never loosen them in a pull request it merges itself.
  "**/AGENTS.md",
  "**/CLAUDE.md",
  ".claude/**",
  ".cursor/**",
  "**/.cursorrules",
];

/**
 * Built-in low-risk paths: docs, notes, images, fonts and tests. These are checked
 * right after the high tier, so a repo's medium rules cannot pull a README up.
 */
export const DEFAULT_LOW: readonly string[] = [
  "**/*.md",
  "**/*.mdx",
  "**/*.txt",
  "**/LICENSE",
  "docs/**",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.webp",
  "**/*.avif",
  "**/*.svg",
  "**/*.ico",
  "**/*.woff",
  "**/*.woff2",
  "**/*.test.*",
  "**/*.spec.*",
  "**/__tests__/**",
];

/** Lockfile-only changes are dependency bumps, not docs. */
export const DEFAULT_MEDIUM: readonly string[] = [
  "**/pnpm-lock.yaml",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/bun.lockb",
];

export const DEFAULT_KEYWORDS: readonly string[] = [
  "auth",
  "login",
  "logout",
  "signin",
  "sign-in",
  "signup",
  "sign-up",
  "session",
  "password",
  "twofactor",
  "two-factor",
  "2fa",
  "billing",
  "payment",
  "stripe",
  "checkout",
  "invoice",
  "webhook",
  "migrat",
  "cron",
  "worker",
  "scheduler",
  "permission",
];

export const DEFAULT_LIMITS: BlastRadiusLimits = {
  coreFiles: 6,
  coreLines: 150,
  fanoutMedium: 15,
  fanoutHigh: 25,
};

export const DEFAULT_CONFIG: BlastRadiusConfig = {
  high: [],
  medium: [],
  low: [],
  keywords: [...DEFAULT_KEYWORDS],
  keywordIgnore: [],
  unmatched: "medium",
  limits: { ...DEFAULT_LIMITS },
  overrideLabel: "needs-human",
  fanout: true,
};

const DOC_LIKE = /\.(md|mdx|txt|png|jpe?g|gif|webp|avif|svg|ico|woff2?)$/i;
const TEST_LIKE = /(\.(test|spec)\.[^/]+$)|(^|\/)__tests__\//;
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;

export interface ClassifiedFile extends ChangedPath {
  tier: Tier;
  /** Why the file landed in its tier, for the report. */
  why: string;
}

export interface BlastRadiusResult {
  verdict: Verdict;
  /** One line per reason, most important first. */
  reasons: string[];
  files: ClassifiedFile[];
  /** Changed lines across medium-tier files. */
  coreLines: number;
}

/**
 * Classify a pull request's changed files and decide whether it may auto-merge.
 *
 * Each file takes the first tier that matches, in this order: built-in and repo
 * high rules, built-in low rules (docs, images, tests), the keyword net, built-in
 * and repo medium rules, repo low rules, then `unmatched`. Fan-out can then push
 * a file up one tier when the PR changes or removes existing lines in a file
 * many others import. Purely additive edits never bump.
 *
 * `importers` maps a repo path to how many files import it directly. Pass an
 * empty map when the repo is not checked out; the rules still work, just without
 * the fan-out signal.
 */
export function classifyChange(
  files: readonly ChangedPath[],
  config: BlastRadiusConfig,
  importers: ReadonlyMap<string, number> = new Map(),
  labels: readonly string[] = [],
): BlastRadiusResult {
  const isHigh = compileGlobs([...DEFAULT_HIGH, ...config.high]);
  const isBuiltinLow = compileGlobs(DEFAULT_LOW);
  const isMedium = compileGlobs([...DEFAULT_MEDIUM, ...config.medium]);
  const isLow = compileGlobs(config.low);
  const keywords = config.keywords.map((k) => k.toLowerCase());
  const isKeywordIgnored = compileGlobs(config.keywordIgnore);

  // A rename moves risk out of the old path as well as into the new one.
  const judged: ChangedPath[] = files.flatMap((file) =>
    file.previousPath
      ? [file, { path: file.previousPath, status: "removed", additions: 0, deletions: 0 }]
      : [file],
  );

  const classified: ClassifiedFile[] = judged.map((file) => {
    const name = (file.path.split("/").pop() ?? file.path).toLowerCase();
    let tier: Tier;
    let why: string;
    if (isHigh(file.path)) {
      tier = "high";
      why = "high-risk path";
    } else if (isBuiltinLow(file.path)) {
      tier = "low";
      why = "docs, images or tests";
    } else if (
      !DOC_LIKE.test(name) &&
      !TEST_LIKE.test(file.path) &&
      !isKeywordIgnored(file.path) &&
      keywords.some((k) => name.includes(k))
    ) {
      tier = "high";
      why = `file name mentions "${keywords.find((k) => name.includes(k))}"`;
    } else if (isMedium(file.path)) {
      tier = "medium";
      why = "core code";
    } else if (isLow(file.path)) {
      tier = "low";
      why = "low-risk path";
    } else {
      tier = config.unmatched;
      why = "no rule matched";
    }

    if (tier === "low" && file.status === "removed" && SOURCE_FILE.test(file.path)) {
      tier = "medium";
      why = "source file deleted";
    }

    const count = importers.get(file.path) ?? 0;
    if (file.deletions > 0 && config.fanout) {
      if (tier === "low" && count > config.limits.fanoutMedium) {
        tier = "medium";
        why = `imported by ${count} files`;
      } else if (tier === "medium" && count > config.limits.fanoutHigh) {
        tier = "high";
        why = `imported by ${count} files`;
      }
    }
    return { ...file, tier, why };
  });

  const high = classified.filter((f) => f.tier === "high");
  const medium = classified.filter((f) => f.tier === "medium");
  const coreLines = medium.reduce((sum, f) => sum + f.additions + f.deletions, 0);
  const reasons: string[] = [];
  let verdict: Verdict;

  const override = labels.includes(config.overrideLabel);
  if (override) {
    reasons.push(`labelled ${config.overrideLabel}`);
  }
  if (high.length > 0) {
    reasons.push(
      `touches high-risk files: ${high
        .slice(0, 5)
        .map((f) => `${f.path} (${f.why})`)
        .join(", ")}${high.length > 5 ? `, and ${high.length - 5} more` : ""}`,
    );
  }
  const tooBig =
    medium.length > config.limits.coreFiles || coreLines > config.limits.coreLines;
  if (tooBig) {
    reasons.push(
      `core change is ${medium.length} files and ${coreLines} lines, over the auto-merge limit of ${config.limits.coreFiles} files and ${config.limits.coreLines} lines`,
    );
  }

  if (override || high.length > 0) {
    verdict = "human";
  } else if (tooBig) {
    verdict = "review";
  } else {
    verdict = "auto";
    reasons.push(
      medium.length > 0
        ? `small core change: ${medium.length} files, ${coreLines} lines`
        : "only low-risk files changed",
    );
  }

  return { verdict, reasons, files: classified, coreLines };
}
