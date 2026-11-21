import { describe, expect, it } from "vitest";
import { globToRegExp } from "../src/blastRadius/glob.js";
import { BlastRadiusConfigError, loadBlastRadiusConfig, parseJsonc } from "../src/blastRadius/config.js";
import { classifyChange, type ChangedPath } from "../src/blastRadius/rules.js";

const file = (path: string, additions = 5, deletions = 0, status = "modified"): ChangedPath => ({
  path,
  status,
  additions,
  deletions,
});

const APP_CONFIG = loadBlastRadiusConfig(
  JSON.stringify({
    blastRadius: {
      high: ["server/db.ts", "src/main.tsx"],
      medium: ["server/**", "src/lib/**"],
      low: ["src/**"],
    },
  }),
);

describe("globToRegExp", () => {
  it("matches across directories with ** and within one with *", () => {
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test(".scratch/a/b/notes.md")).toBe(true);
    expect(globToRegExp("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(globToRegExp("src/**").test("src/a/b.ts")).toBe(true);
    expect(globToRegExp("backend/src/services/auth*").test("backend/src/services/authService.ts")).toBe(true);
  });

  it("treats regex characters in paths literally", () => {
    expect(globToRegExp("apps/web/src/routes/sign-in.$.tsx").test("apps/web/src/routes/sign-in.$.tsx")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("classifyChange", () => {
  it("lets a huge copy-only change auto-merge", () => {
    const result = classifyChange(
      [file("docs/guide.md", 8000), file("src/pages/about.tsx", 400, 300)],
      APP_CONFIG,
    );
    expect(result.verdict).toBe("auto");
    expect(result.reasons).toEqual(["only low-risk files changed"]);
  });

  it("sends anything touching a high-risk path to a person", () => {
    const result = classifyChange([file("src/pages/a.tsx"), file("server/db.ts", 1)], APP_CONFIG);
    expect(result.verdict).toBe("human");
    expect(result.reasons[0]).toContain("server/db.ts");
  });

  it("treats built-in risky paths as high in every repo", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      "package.json",
      "apps/api/package.json",
      "packages/db/prisma/schema.prisma",
      "backend/src/migrations/2026-add-table.ts",
      ".env.production",
      "railway.json",
    ]) {
      expect(classifyChange([file(path)], APP_CONFIG).verdict, path).toBe("human");
    }
  });

  it("catches risky file names anywhere through the keyword net", () => {
    const result = classifyChange([file("src/components/login-form.tsx")], APP_CONFIG);
    expect(result.verdict).toBe("human");
    expect(result.files[0]?.why).toContain("login");
  });

  it("skips the keyword net for tests, docs and ignored paths", () => {
    const config = loadBlastRadiusConfig(
      JSON.stringify({ blastRadius: { low: ["src/**"], keywordIgnore: ["src/components/session-badge.tsx"] } }),
    );
    expect(classifyChange([file("src/auth.test.ts")], config).verdict).toBe("auto");
    expect(classifyChange([file("docs/auth.md")], config).verdict).toBe("auto");
    expect(classifyChange([file("src/components/session-badge.tsx")], config).verdict).toBe("auto");
  });

  it("auto-merges a small core change and holds a large one for review", () => {
    const small = classifyChange([file("server/routes.ts", 8, 4)], APP_CONFIG);
    expect(small.verdict).toBe("auto");
    expect(small.reasons[0]).toBe("small core change: 1 files, 12 lines");

    const large = classifyChange([file("server/routes.ts", 140, 20)], APP_CONFIG);
    expect(large.verdict).toBe("review");
    expect(large.coreLines).toBe(160);
  });

  it("checks medium rules before low ones, so a core file inside a UI folder stays core", () => {
    const result = classifyChange([file("src/lib/api.ts", 10)], APP_CONFIG);
    expect(result.files[0]?.tier).toBe("medium");
  });

  it("counts unmatched files as medium by default", () => {
    const result = classifyChange([file("scripts/backfill.ts", 10)], APP_CONFIG);
    expect(result.files[0]?.tier).toBe("medium");
  });

  it("bumps widely imported files only when existing lines change", () => {
    const importers = new Map([
      ["src/components/button.tsx", 80],
      ["src/lib/utils.ts", 40],
    ]);
    const additive = classifyChange([file("src/components/button.tsx", 20, 0)], APP_CONFIG, importers);
    expect(additive.verdict).toBe("auto");

    const edited = classifyChange([file("src/components/button.tsx", 2, 2)], APP_CONFIG, importers);
    expect(edited.files[0]).toMatchObject({ tier: "medium", why: "imported by 80 files" });

    const core = classifyChange([file("src/lib/utils.ts", 1, 1)], APP_CONFIG, importers);
    expect(core.verdict).toBe("human");
  });

  it("treats a deleted source file as at least core code", () => {
    const result = classifyChange([file("src/pages/old.tsx", 0, 40, "removed")], APP_CONFIG);
    expect(result.files[0]?.tier).toBe("medium");
  });

  it("judges the old path of a rename too", () => {
    const result = classifyChange(
      [{ ...file("src/pages/db-view.tsx", 0, 0, "renamed"), previousPath: "server/db.ts" }],
      APP_CONFIG,
    );
    expect(result.verdict).toBe("human");
  });

  it("lets a person force review with the override label", () => {
    const result = classifyChange([file("README.md")], APP_CONFIG, new Map(), ["needs-human"]);
    expect(result.verdict).toBe("human");
    expect(result.reasons[0]).toBe("labelled needs-human");
  });
});

describe("loadBlastRadiusConfig", () => {
  it("uses the defaults when the repo has no config", () => {
    const config = loadBlastRadiusConfig(null);
    expect(config.limits).toEqual({ coreFiles: 6, coreLines: 150, fanoutMedium: 15, fanoutHigh: 25 });
    expect(config.overrideLabel).toBe("needs-human");
  });

  it("reads comments, trailing commas, limits and keyword changes", () => {
    const config = loadBlastRadiusConfig(`{
      // tuned for this repo
      "blastRadius": {
        "limits": { "coreLines": 80, },
        "keywords": ["auth"],
        "extraKeywords": ["payout"],
      },
    }`);
    expect(config.limits.coreLines).toBe(80);
    expect(config.limits.coreFiles).toBe(6);
    expect(config.keywords).toEqual(["auth", "payout"]);
  });

  it("turns the keyword net off with false", () => {
    expect(loadBlastRadiusConfig('{"blastRadius":{"keywords":false}}').keywords).toEqual([]);
  });

  it("rejects malformed config so the caller can fail closed", () => {
    expect(() => loadBlastRadiusConfig("{not json")).toThrow(BlastRadiusConfigError);
    expect(() => loadBlastRadiusConfig('{"blastRadius":{"high":"src/**"}}')).toThrow(/list of strings/);
    expect(() => loadBlastRadiusConfig('{"blastRadius":{"limits":{"coreFiles":-1}}}')).toThrow(/whole number/);
    expect(() => loadBlastRadiusConfig('{"blastRadius":{"unmatched":"none"}}')).toThrow(/unmatched/);
  });
});

describe("parseJsonc", () => {
  it("keeps comment markers inside strings", () => {
    expect(parseJsonc('{"a": "http://x/*y*/", /* c */ "b": 1}')).toEqual({ a: "http://x/*y*/", b: 1 });
  });
});
