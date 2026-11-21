import { DEFAULT_CONFIG, type BlastRadiusConfig, type Tier } from "./rules.js";

/**
 * Parse JSON that may carry comments and trailing commas, as tsconfig files and
 * hand-written config often do. Comment markers inside strings are left alone.
 */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export class BlastRadiusConfigError extends Error {
  override name = "BlastRadiusConfigError";
}

const TIERS: readonly Tier[] = ["high", "medium", "low"];

function stringList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new BlastRadiusConfigError(`blastRadius.${field} must be a list of strings.`);
  }
  return value as string[];
}

function positiveInt(value: unknown, field: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new BlastRadiusConfigError(`blastRadius.limits.${field} must be a whole number of 0 or more.`);
  }
  return value;
}

/**
 * Build a repo's rules from the text of its PostDev config file, which holds a
 * `blastRadius` object. Missing fields take PostDev's defaults; the built-in
 * high, low and medium paths always apply, and the repo's lists add to them.
 * A missing file (null text) means "all defaults". Anything malformed throws,
 * so the caller can fail closed rather than run with half a rule set.
 */
export function loadBlastRadiusConfig(text: string | null): BlastRadiusConfig {
  if (text === null) return structuredClone(DEFAULT_CONFIG);

  let parsed: unknown;
  try {
    parsed = parseJsonc(text);
  } catch (error) {
    throw new BlastRadiusConfigError(
      `The PostDev config file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const root = (parsed ?? {}) as Record<string, unknown>;
  const raw = (root.blastRadius ?? {}) as Record<string, unknown>;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BlastRadiusConfigError("blastRadius must be an object.");
  }

  let keywords = [...DEFAULT_CONFIG.keywords];
  if (raw.keywords === false) keywords = [];
  else if (raw.keywords !== undefined) keywords = stringList(raw.keywords, "keywords");
  keywords.push(...stringList(raw.extraKeywords, "extraKeywords"));

  const unmatched = raw.unmatched ?? DEFAULT_CONFIG.unmatched;
  if (!TIERS.includes(unmatched as Tier)) {
    throw new BlastRadiusConfigError(`blastRadius.unmatched must be one of: ${TIERS.join(", ")}.`);
  }

  const limits = (raw.limits ?? {}) as Record<string, unknown>;
  const overrideLabel = raw.overrideLabel ?? DEFAULT_CONFIG.overrideLabel;
  if (typeof overrideLabel !== "string" || overrideLabel === "") {
    throw new BlastRadiusConfigError("blastRadius.overrideLabel must be a label name.");
  }
  if (raw.fanout !== undefined && typeof raw.fanout !== "boolean") {
    throw new BlastRadiusConfigError("blastRadius.fanout must be true or false.");
  }

  return {
    high: stringList(raw.high, "high"),
    medium: stringList(raw.medium, "medium"),
    low: stringList(raw.low, "low"),
    keywords,
    keywordIgnore: stringList(raw.keywordIgnore, "keywordIgnore"),
    unmatched: unmatched as Tier,
    limits: {
      coreFiles: positiveInt(limits.coreFiles, "coreFiles", DEFAULT_CONFIG.limits.coreFiles),
      coreLines: positiveInt(limits.coreLines, "coreLines", DEFAULT_CONFIG.limits.coreLines),
      fanoutMedium: positiveInt(limits.fanoutMedium, "fanoutMedium", DEFAULT_CONFIG.limits.fanoutMedium),
      fanoutHigh: positiveInt(limits.fanoutHigh, "fanoutHigh", DEFAULT_CONFIG.limits.fanoutHigh),
    },
    overrideLabel,
    fanout: (raw.fanout as boolean | undefined) ?? DEFAULT_CONFIG.fanout,
  };
}
