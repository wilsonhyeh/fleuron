import { describe, expect, it } from "vitest";
import { groupPassageChips, nextCoding } from "./passage-chips";
import type { Code, CodedSegment } from "./types";

function code(id: string): Code {
  return {
    id,
    name: id,
    definition: null,
    inclusion_criteria: null,
    exclusion_criteria: null,
    example: null,
    parent_id: null,
    color: "#888888",
    sort_order: 0,
    is_retired: false,
    usage_count: 0,
  };
}

function coding(id: string, codeIds: string[], start: number | null, coder = "Ada"): CodedSegment {
  return {
    id,
    interview_id: "iv",
    segment_id: "seg",
    code_ids: codeIds,
    coder_name: coder,
    memo: null,
    char_start: start,
    char_end: start == null ? null : start + 5,
    quote_text: "",
    block_id: null,
    timestamp_start: "00:00:00.000",
    participant_label: "P01",
  };
}

const codesById = new Map(["c10", "c15", "c3"].map((id) => [id, code(id)]));

describe("groupPassageChips", () => {
  it("shows a code once per coder, with every span that carries it in text order", () => {
    const groups = groupPassageChips(
      [coding("late", ["c10"], 40), coding("early", ["c15", "c10"], 0)],
      "Ada",
      codesById,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].chips.map((c) => [c.code.id, c.codings.map((x) => x.id)])).toEqual([
      ["c15", ["early"]],
      ["c10", ["early", "late"]],
    ]);
  });

  it("puts the active coder first and keeps other coders' chips apart", () => {
    const groups = groupPassageChips(
      [coding("l", ["c10"], 0, "Luci"), coding("a", ["c10"], 10, "Ada")],
      "Ada",
      codesById,
    );
    expect(groups.map((g) => [g.coder, g.theirs, g.chips.length])).toEqual([
      ["Ada", false, 1],
      ["Luci", true, 1],
    ]);
  });

  it("drops codings whose codes are all unknown", () => {
    expect(groupPassageChips([coding("x", ["gone"], 0)], "Ada", codesById)).toEqual([]);
  });
});

describe("nextCoding", () => {
  const spans = [coding("whole", ["c10"], null), coding("a", ["c10"], 0), coding("b", ["c10"], 20)];

  it("starts at the first span", () => {
    expect(nextCoding(spans, null).id).toBe("whole");
    expect(nextCoding(spans, "some-other-coding").id).toBe("whole");
  });

  it("steps to the next span and wraps", () => {
    expect(nextCoding(spans, "whole").id).toBe("a");
    expect(nextCoding(spans, "a").id).toBe("b");
    expect(nextCoding(spans, "b").id).toBe("whole");
  });
});
