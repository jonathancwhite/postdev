import { describe, expect, it } from "vitest";
import { parseFindings } from "../src/model/reviewModel.js";

describe("parseFindings", () => {
  it("parses a valid findings array", () => {
    const text = JSON.stringify({
      findings: [
        {
          file: "x.ts",
          line: 3,
          severity: "high",
          category: "correctness",
          message: "unhandled null",
          confidence: 0.8,
        },
      ],
    });

    expect(parseFindings(text)).toEqual([
      {
        file: "x.ts",
        line: 3,
        severity: "high",
        category: "correctness",
        message: "unhandled null",
        confidence: 0.8,
      },
    ]);
  });

  it("treats an empty findings array as a valid clean result", () => {
    expect(parseFindings(JSON.stringify({ findings: [] }))).toEqual([]);
  });

  it("rejects a response with no findings array", () => {
    expect(() => parseFindings(JSON.stringify({ other: 1 }))).toThrow();
  });

  it("rejects a finding with an invalid severity", () => {
    const text = JSON.stringify({
      findings: [
        {
          file: "x.ts",
          line: 3,
          severity: "blocker",
          category: "correctness",
          message: "m",
          confidence: 0.5,
        },
      ],
    });
    expect(() => parseFindings(text)).toThrow(/severity/);
  });

  it("rejects a finding missing a required field", () => {
    const text = JSON.stringify({
      findings: [{ file: "x.ts", line: 3, severity: "high" }],
    });
    expect(() => parseFindings(text)).toThrow();
  });
});
