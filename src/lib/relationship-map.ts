import type { Code, CodedSegment, Interview } from "./types";

/**
 * The study's relationships, derived from coding the researcher has already
 * done. Nothing here is stored: every view is recomputed from the live
 * codebook and codings, so the map is always exactly what the study says now.
 *
 * A *passage* is one transcript segment. Two codes are related when some
 * passage carries both, whoever coded it and whichever span of it they
 * marked — the same "distinct passages" unit `usage_count` counts in.
 */

export interface MapPassage {
  /** The transcript segment id. */
  segmentId: string;
  interviewId: string;
  participantLabel: string;
  timestampStart: string;
  /** Longest quote any coding on this passage carries. */
  quote: string;
  codeIds: string[];
  coders: string[];
  memo: string | null;
}

export interface MapNode {
  id: string;
  name: string;
  color: string;
  parentId: string | null;
  /** Distinct passages carrying this code. */
  count: number;
  definition: string | null;
}

export interface MapLink {
  /** Stable key: the two code ids, sorted, joined. */
  key: string;
  source: string;
  target: string;
  /** Distinct passages carrying both codes. */
  weight: number;
  passageIds: string[];
}

export interface RelationshipGraph {
  nodes: MapNode[];
  links: MapLink[];
  passages: MapPassage[];
  /** Codes in the codebook that no passage carries yet. */
  unusedCodes: MapNode[];
}

export function linkKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Fold every coding onto its passage: one entry per segment, codes unioned. */
export function collectPassages(
  codes: Code[],
  codedSegments: CodedSegment[],
): MapPassage[] {
  const live = new Set(codes.filter((c) => !c.is_retired).map((c) => c.id));
  const bySegment = new Map<string, MapPassage>();
  for (const coding of codedSegments) {
    const ids = coding.code_ids.filter((id) => live.has(id));
    if (ids.length === 0) continue;
    let p = bySegment.get(coding.segment_id);
    if (!p) {
      p = {
        segmentId: coding.segment_id,
        interviewId: coding.interview_id,
        participantLabel: coding.participant_label,
        timestampStart: coding.timestamp_start,
        quote: coding.quote_text,
        codeIds: [],
        coders: [],
        memo: coding.memo,
      };
      bySegment.set(coding.segment_id, p);
    }
    for (const id of ids) if (!p.codeIds.includes(id)) p.codeIds.push(id);
    if (!p.coders.includes(coding.coder_name)) p.coders.push(coding.coder_name);
    if (coding.quote_text.length > p.quote.length) p.quote = coding.quote_text;
    if (!p.memo && coding.memo) p.memo = coding.memo;
  }
  return [...bySegment.values()];
}

export function buildRelationshipGraph(
  codes: Code[],
  codedSegments: CodedSegment[],
): RelationshipGraph {
  const passages = collectPassages(codes, codedSegments);
  const counts = new Map<string, number>();
  const links = new Map<string, MapLink>();

  for (const p of passages) {
    for (const id of p.codeIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const ids = [...p.codeIds].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = linkKey(ids[i], ids[j]);
        let link = links.get(key);
        if (!link) {
          link = { key, source: ids[i], target: ids[j], weight: 0, passageIds: [] };
          links.set(key, link);
        }
        link.weight += 1;
        link.passageIds.push(p.segmentId);
      }
    }
  }

  const nodes: MapNode[] = [];
  const unusedCodes: MapNode[] = [];
  for (const c of codes) {
    if (c.is_retired) continue;
    const node: MapNode = {
      id: c.id,
      name: c.name,
      color: c.color,
      parentId: c.parent_id,
      count: counts.get(c.id) ?? 0,
      definition: c.definition,
    };
    (node.count > 0 ? nodes : unusedCodes).push(node);
  }

  return {
    nodes,
    links: [...links.values()].sort((a, b) => b.weight - a.weight),
    passages,
    unusedCodes,
  };
}

/** The codes a code shares passages with, strongest first. */
export function neighbours(
  graph: RelationshipGraph,
  codeId: string,
): { node: MapNode; link: MapLink }[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: { node: MapNode; link: MapLink }[] = [];
  for (const link of graph.links) {
    const other =
      link.source === codeId ? link.target : link.target === codeId ? link.source : null;
    const node = other ? byId.get(other) : undefined;
    if (node) out.push({ node, link });
  }
  return out.sort((a, b) => b.link.weight - a.link.weight);
}

// ── Timeline ────────────────────────────────────────────────────────────────

export interface TimelineMark {
  segmentId: string;
  /** Position in the interview, 0..1. */
  at: number;
}

export interface TimelineLane {
  code: MapNode;
  marks: TimelineMark[];
}

export interface TimelineInterview {
  interview: Interview;
  /** Segment index by id, for every passage this interview has coded. */
  lanes: TimelineLane[];
}

/**
 * Where each code falls through each interview. Positions come from the
 * passage's order in its transcript (`segmentIndex`), normalised by the
 * interview's length, so interviews of different lengths line up.
 */
export function buildTimeline(
  graph: RelationshipGraph,
  interviews: Interview[],
  segmentIndex: Map<string, number>,
): TimelineInterview[] {
  const result: TimelineInterview[] = [];
  for (const iv of interviews) {
    const length = Math.max(1, iv.segment_count || iv.remote_segment_count || 1);
    const lanes = new Map<string, TimelineLane>();
    for (const p of graph.passages) {
      if (p.interviewId !== iv.id) continue;
      const index = segmentIndex.get(p.segmentId);
      if (index == null) continue;
      const at = length <= 1 ? 0.5 : Math.min(1, index / (length - 1));
      for (const id of p.codeIds) {
        const node = graph.nodes.find((n) => n.id === id);
        if (!node) continue;
        let lane = lanes.get(id);
        if (!lane) {
          lane = { code: node, marks: [] };
          lanes.set(id, lane);
        }
        lane.marks.push({ segmentId: p.segmentId, at });
      }
    }
    if (lanes.size === 0) continue;
    result.push({
      interview: iv,
      lanes: [...lanes.values()].sort(
        (a, b) => Math.min(...a.marks.map((m) => m.at)) - Math.min(...b.marks.map((m) => m.at)),
      ),
    });
  }
  return result;
}

// ── Structure ───────────────────────────────────────────────────────────────

export interface TreeTheme {
  node: MapNode;
  /** Passages carrying the theme or any of its sub-codes. */
  rollup: number;
  children: MapNode[];
}

/** Top-level codes with their sub-codes, including codes not yet used. */
export function buildStructure(graph: RelationshipGraph, codes: Code[]): TreeTheme[] {
  const all = [...graph.nodes, ...graph.unusedCodes];
  const byId = new Map(all.map((n) => [n.id, n]));
  const order = new Map(codes.map((c) => [c.id, c.sort_order]));
  const sort = (a: MapNode, b: MapNode) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  const themes = all.filter((n) => !n.parentId || !byId.has(n.parentId)).sort(sort);
  return themes.map((node) => {
    const children = all.filter((n) => n.parentId === node.id).sort(sort);
    const ids = new Set([node.id, ...children.map((c) => c.id)]);
    const rollup = graph.passages.filter((p) => p.codeIds.some((id) => ids.has(id))).length;
    return { node, rollup, children };
  });
}
