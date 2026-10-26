import { describe, expect, it } from "vitest";
import { buildRelationshipGraph, buildStructure, buildTimeline, linkKey } from "./relationship-map";
import type { Code, CodedSegment, Interview } from "./types";

const code = (id: string, parent: string | null = null, retired = false): Code => ({
  id,
  name: id.toUpperCase(),
  definition: null,
  inclusion_criteria: null,
  exclusion_criteria: null,
  example: null,
  parent_id: parent,
  color: "#123456",
  sort_order: 0,
  is_retired: retired,
  usage_count: 0,
});

const coding = (
  segment: string,
  codeIds: string[],
  coder = "A",
  span: [number, number] | null = null,
): CodedSegment => ({
  id: `${segment}-${coder}-${span?.join("-") ?? "whole"}`,
  interview_id: "iv",
  segment_id: segment,
  code_ids: codeIds,
  coder_name: coder,
  memo: null,
  char_start: span?.[0] ?? null,
  char_end: span?.[1] ?? null,
  quote_text: `quote ${segment}`,
  block_id: null,
  timestamp_start: "00:00:00",
  participant_label: "P01",
});

describe("buildRelationshipGraph", () => {
  const codes = [code("a"), code("b"), code("c"), code("d", "a"), code("old", null, true)];

  it("links two codes once per shared passage, whoever coded it", () => {
    const graph = buildRelationshipGraph(codes, [
      coding("s1", ["a", "b"]),
      coding("s1", ["b"], "B"),
      coding("s2", ["a"], "A", [0, 4]),
      coding("s2", ["b"], "A", [5, 9]),
      coding("s3", ["c"]),
    ]);
    const ab = graph.links.find((l) => l.key === linkKey("a", "b"));
    expect(ab?.weight).toBe(2);
    expect(ab?.passageIds.sort()).toEqual(["s1", "s2"]);
    expect(graph.links).toHaveLength(1);
    expect(graph.nodes.find((n) => n.id === "b")?.count).toBe(2);
  });

  it("leaves out retired codes and lists unused ones separately", () => {
    const graph = buildRelationshipGraph(codes, [coding("s1", ["a", "old"])]);
    expect(graph.links).toHaveLength(0);
    expect(graph.nodes.map((n) => n.id)).toEqual(["a"]);
    expect(graph.unusedCodes.map((n) => n.id).sort()).toEqual(["b", "c", "d"]);
  });

  it("rolls sub-codes up into their theme in the structure view", () => {
    const graph = buildRelationshipGraph(codes, [coding("s1", ["d"]), coding("s2", ["a"])]);
    const themes = buildStructure(graph, codes);
    const a = themes.find((t) => t.node.id === "a");
    expect(a?.children.map((c) => c.id)).toEqual(["d"]);
    expect(a?.rollup).toBe(2);
  });

  it("places timeline marks by transcript position", () => {
    const graph = buildRelationshipGraph(codes, [coding("s1", ["a"]), coding("s3", ["a"])]);
    const interview = { id: "iv", participant_label: "P01", segment_count: 5 } as Interview;
    const [row] = buildTimeline(graph, [interview], new Map([["s1", 0], ["s3", 4]]));
    expect(row.lanes[0].marks.map((m) => m.at)).toEqual([0, 1]);
  });
});
