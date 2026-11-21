import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { countImporters, findImportSpecifiers } from "../src/blastRadius/importGraph.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/import-graph", import.meta.url));

describe("findImportSpecifiers", () => {
  it("finds static, multi-line, side-effect, dynamic and require imports", () => {
    const specs = findImportSpecifiers(`
      import a from "./a";
      import {
        b,
        c,
      } from '../b';
      export { d } from "./d";
      import "./styles";
      const e = await import("./e");
      const f = require("f-pkg");
      import type { G } from "@/g";
    `);
    expect(specs.sort()).toEqual(["../b", "./a", "./d", "./e", "./styles", "@/g", "f-pkg"].sort());
  });
});

describe("countImporters", () => {
  it("resolves relative paths, tsconfig aliases, .js specifiers and workspace packages", async () => {
    const counts = await countImporters(FIXTURE);
    expect(counts.get("apps/web/src/lib/utils.ts")).toBe(3);
    expect(counts.get("apps/web/src/components/button.tsx")).toBe(1);
    expect(counts.get("apps/web/src/components/card.tsx")).toBe(1);
    expect(counts.get("packages/shared/src/index.ts")).toBe(1);
    expect(counts.get("packages/shared/src/format.ts")).toBe(1);
    expect(counts.has("apps/web/src/main.tsx")).toBe(false);
  });
});
