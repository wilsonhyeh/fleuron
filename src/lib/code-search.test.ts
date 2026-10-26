import { describe, expect, it } from "vitest";
import { codeMatchesQuery, codeWithSubCodes, compareCodeNames } from "./code-search";
import type { Code } from "./types";

function code(overrides: Partial<Code> = {}): Code {
  return {
    id: "c1",
    name: "Trust",
    definition: "Asks who holds the notes",
    inclusion_criteria: "Mentions of relying on a colleague",
    exclusion_criteria: "General confidence",
    example: "I let her keep the drive",
    parent_id: null,
    color: "#888888",
    sort_order: 0,
    is_retired: false,
    usage_count: 0,
    ...overrides,
  };
}

describe("codeMatchesQuery", () => {
  it("matches the name", () => {
    expect(codeMatchesQuery(code(), "trust")).toBe(true);
    expect(codeMatchesQuery(code(), "TRUST")).toBe(true);
  });

  it("matches a word that appears only in the definition", () => {
    expect(codeMatchesQuery(code(), "notes")).toBe(true);
  });

  it("matches inclusion, exclusion, and example text", () => {
    expect(codeMatchesQuery(code(), "relying")).toBe(true);
    expect(codeMatchesQuery(code(), "confidence")).toBe(true);
    expect(codeMatchesQuery(code(), "drive")).toBe(true);
  });

  it("rejects non-matches and matches everything on a blank query", () => {
    expect(codeMatchesQuery(code(), "zebra")).toBe(false);
    expect(codeMatchesQuery(code(), "   ")).toBe(true);
  });

  it("tolerates null descriptive fields", () => {
    const bare = code({
      definition: null,
      inclusion_criteria: null,
      exclusion_criteria: null,
      example: null,
    });
    expect(codeMatchesQuery(bare, "trust")).toBe(true);
    expect(codeMatchesQuery(bare, "notes")).toBe(false);
  });
});

describe("compareCodeNames", () => {
  it("orders numbered names numerically, ignoring case", () => {
    const names = ["Concept 10", "concept 2", "Concept 1", "Barrier", "Concept 11"];
    const sorted = names.map((name) => code({ name })).sort(compareCodeNames).map((c) => c.name);
    expect(sorted).toEqual(["Barrier", "Concept 1", "concept 2", "Concept 10", "Concept 11"]);
  });
});

describe("codeWithSubCodes", () => {
  it("includes live sub-codes and skips retired ones", () => {
    const codes = [
      code({ id: "p" }),
      code({ id: "a", parent_id: "p" }),
      code({ id: "b", parent_id: "p", is_retired: true }),
      code({ id: "x" }),
    ];
    expect([...codeWithSubCodes("p", codes)].sort()).toEqual(["a", "p"]);
    expect([...codeWithSubCodes("a", codes)]).toEqual(["a"]);
  });
});
