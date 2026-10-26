import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { ForceSim, type SimLink } from "../lib/force-layout";
import {
  buildRelationshipGraph,
  buildStructure,
  buildTimeline,
  neighbours,
  type MapLink,
  type MapNode,
  type MapPassage,
  type RelationshipGraph,
} from "../lib/relationship-map";
import type { CodedSegment, Interview } from "../lib/types";
import { useMapStore, type MapView } from "../store/map-store";
import { useProjectStore } from "../store/project-store";
import { useDisplayCodes } from "../hooks/useDisplayCodes";
import { Icon } from "./ui/Icon";
import { Tooltip } from "./ui/Tooltip";

/**
 * The relationship map: what the researcher's coding says about how their
 * codes connect, drawn live beside the transcript.
 *
 * Three readings of the same coding:
 *  - Network: codes as nodes, linked when a passage carries both.
 *  - Timeline: where each code falls through each interview.
 *  - Structure: the codebook's themes and sub-codes, sized by use.
 *
 * Nothing is exported or stored. Every frame is derived from the live
 * codebook and codings, so coding a passage changes the map in place.
 */

type Selection = { kind: "code"; id: string } | { kind: "link"; key: string } | null;

const VIEWS: { id: MapView; label: string }[] = [
  { id: "network", label: "Network" },
  { id: "timeline", label: "Timeline" },
  { id: "structure", label: "Structure" },
];

// ── Data ────────────────────────────────────────────────────────────────────

/**
 * Every coding in the study. The active interview's codings come straight
 * from the project store, so a code applied a moment ago is on the map before
 * any refetch; the rest are refetched whenever the local revision moves.
 */
function useStudyCodings(): CodedSegment[] {
  const activeInterviewId = useProjectStore((s) => s.activeInterviewId);
  const liveCoded = useProjectStore((s) => s.codedSegments);
  const localRevision = useProjectStore((s) => s.localRevision);
  const interviewCount = useProjectStore((s) => s.interviews.length);
  const codes = useDisplayCodes();
  const [all, setAll] = useState<CodedSegment[]>([]);
  const requested = useRef(0);
  const applied = useRef(0);

  // Every change asks again, and any answer newer than the one showing is
  // used. Not a debounce: a debounce that restarts on each change can starve
  // forever while the store keeps moving, and the map silently goes stale.
  useEffect(() => {
    const id = ++requested.current;
    api
      .listCodedSegments()
      .then((rows) => {
        if (id > applied.current) {
          applied.current = id;
          setAll(rows);
        }
      })
      .catch(() => {
        // The map is a view; a failed read leaves the last good picture.
      });
  }, [localRevision, liveCoded, interviewCount, codes]);

  return useMemo(() => {
    if (!activeInterviewId) return all;
    return [...all.filter((c) => c.interview_id !== activeInterviewId), ...liveCoded];
  }, [all, liveCoded, activeInterviewId]);
}

/** Transcript order for every passage, fetched per interview on demand. */
function useSegmentIndex(interviews: Interview[], enabled: boolean): Map<string, number> {
  const activeInterviewId = useProjectStore((s) => s.activeInterviewId);
  const activeSegments = useProjectStore((s) => s.segments);
  const [fetched, setFetched] = useState<Record<string, Map<string, number>>>({});

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    for (const iv of interviews) {
      if (iv.id === activeInterviewId || fetched[iv.id] || iv.segment_count === 0) continue;
      api
        .getSegments(iv.id)
        .then((segs) => {
          if (cancelled) return;
          setFetched((prev) => ({
            ...prev,
            [iv.id]: new Map(segs.map((s) => [s.id, s.segment_index])),
          }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [interviews, activeInterviewId, enabled, fetched]);

  return useMemo(() => {
    const index = new Map<string, number>();
    for (const m of Object.values(fetched)) for (const [k, v] of m) index.set(k, v);
    for (const s of activeSegments) index.set(s.id, s.segment_index);
    return index;
  }, [fetched, activeSegments]);
}

async function jumpToPassage(p: MapPassage) {
  useMapStore.getState().setExpanded(false);
  const store = useProjectStore.getState();
  if (store.activeInterviewId !== p.interviewId) {
    await store.selectInterview(p.interviewId, p.segmentId);
  }
  useProjectStore.getState().setSelectedSegmentId(p.segmentId, "jump");
}

// ── Pane ────────────────────────────────────────────────────────────────────

export function RelationshipMap() {
  const view = useMapStore((s) => s.view);
  const setView = useMapStore((s) => s.setView);
  const expanded = useMapStore((s) => s.expanded);
  const setExpanded = useMapStore((s) => s.setExpanded);
  const setOpen = useMapStore((s) => s.setOpen);
  const showPassages = useMapStore((s) => s.showPassages);

  const codes = useDisplayCodes();
  const interviews = useProjectStore((s) => s.interviews);
  const title = useProjectStore((s) => s.project?.title ?? "Study");
  const codings = useStudyCodings();
  const graph = useMemo(() => buildRelationshipGraph(codes, codings), [codes, codings]);
  const segmentIndex = useSegmentIndex(interviews, view === "timeline");

  const [selection, setSelection] = useState<Selection>(null);
  // A selection whose code or link no longer exists simply stops showing.
  const selectedNode =
    selection?.kind === "code" ? graph.nodes.find((n) => n.id === selection.id) ?? null : null;
  const selectedLink =
    selection?.kind === "link" ? graph.links.find((l) => l.key === selection.key) ?? null : null;

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector('[role="dialog"]')) {
        e.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, setExpanded]);

  const interviewsWithCoding = new Set(graph.passages.map((p) => p.interviewId)).size;

  return (
    <section
      aria-label="Relationship map"
      data-testid="relationship-map"
      className={`relative flex h-full min-h-0 min-w-0 flex-col bg-[var(--map-ground)] ${
        expanded ? "" : "border-l border-[var(--g-rim)]"
      }`}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--g-rim)] px-4 py-2.5">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 className="eyebrow">Map</h2>
          <span className="truncate text-[11px] text-[var(--ink-4)]">
            {graph.nodes.length} codes · {graph.links.length} connections · {graph.passages.length}{" "}
            passages
            {interviewsWithCoding > 1 ? ` · ${interviewsWithCoding} interviews` : ""}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <div
            role="tablist"
            aria-label="Map view"
            className="flex items-center gap-0.5 rounded-md bg-[var(--fill)] p-0.5 text-[11.5px]"
          >
            {VIEWS.map((v) => (
              <button
                key={v.id}
                type="button"
                role="tab"
                aria-selected={view === v.id}
                onClick={() => setView(v.id)}
                className={`rounded px-2 py-0.5 transition-colors ${
                  view === v.id
                    ? "bg-[var(--fill-on)] font-medium text-[var(--accent)] shadow-xs"
                    : "text-[var(--ink-3)] hover:text-[var(--ink)]"
                }`}
              >
                {v.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            aria-label={expanded ? "Show beside the transcript" : "Fill the window"}
            title={expanded ? "Show beside the transcript (Esc)" : "Fill the window"}
            className="grid h-6 w-6 place-items-center rounded-md text-[var(--ink-3)] hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          >
            <Icon name={expanded ? "collapse" : "expand"} size={13} />
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close map"
            title="Close map (Cmd/Ctrl+Shift+M)"
            className="grid h-6 w-6 place-items-center rounded-md text-[var(--ink-3)] hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        {graph.passages.length === 0 ? (
          <EmptyMap />
        ) : view === "network" ? (
          <NetworkView
            graph={graph}
            showPassages={showPassages}
            selection={selection}
            onSelect={setSelection}
          />
        ) : view === "timeline" ? (
          <TimelineView
            graph={graph}
            interviews={interviews}
            segmentIndex={segmentIndex}
            selectedCodeId={selectedNode?.id ?? null}
            onSelectCode={(id) => setSelection(id ? { kind: "code", id } : null)}
          />
        ) : (
          <StructureView
            graph={graph}
            title={title}
            selectedCodeId={selectedNode?.id ?? null}
            onSelectCode={(id) => setSelection(id ? { kind: "code", id } : null)}
          />
        )}

        {(selectedNode || selectedLink) && (
          <DetailCard
            graph={graph}
            node={selectedNode}
            link={selectedLink}
            onSelect={setSelection}
          />
        )}
      </div>
    </section>
  );
}

function EmptyMap() {
  return (
    <div className="grid h-full place-items-center px-8 text-center">
      <div className="max-w-[300px]">
        <Icon name="network" size={28} className="mx-auto text-[var(--ink-4)]" />
        <p className="mt-3 text-[13px] font-medium text-[var(--ink-2)]">Nothing to map yet</p>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--ink-3)]">
          Code a passage and it appears here. Codes that share a passage are drawn connected.
        </p>
      </div>
    </div>
  );
}

// ── Network ─────────────────────────────────────────────────────────────────

function codeRadius(count: number) {
  return 9 + Math.sqrt(count) * 6.5;
}

function truncate(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

function NetworkView({
  graph,
  showPassages,
  selection,
  onSelect,
}: {
  graph: RelationshipGraph;
  showPassages: boolean;
  selection: Selection;
  onSelect: (s: Selection) => void;
}) {
  const setShowPassages = useMapStore((s) => s.setShowPassages);
  const simRef = useRef<ForceSim | null>(null);
  if (!simRef.current) simRef.current = new ForceSim();
  const sim = simRef.current;
  const svgRef = useRef<SVGSVGElement>(null);
  const viewRef = useRef<ViewBox>({ x: -320, y: -220, w: 640, h: 440 });
  const dragRef = useRef<{ id: string; moved: boolean; startX: number; startY: number } | null>(
    null,
  );
  const [, setFrame] = useState(0);
  const paneRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ w: 600, h: 500 });
  useEffect(() => {
    const el = paneRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setPane({ w: width, h: height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    sim.aspect = Math.min(2.2, Math.max(0.45, pane.w / pane.h));
    sim.reheat(0.3);
  }, [pane, sim]);
  const [hover, setHover] = useState<string | null>(null);
  const [hoverPassage, setHoverPassage] = useState<MapPassage | null>(null);

  // Pulses: a ring swells out of any code whose count just went up, and any
  // connection that just appeared or strengthened glows for a moment.
  const prevCounts = useRef<Map<string, number> | null>(null);
  const prevWeights = useRef<Map<string, number> | null>(null);
  const [pulses, setPulses] = useState<Record<string, number>>({});
  useEffect(() => {
    const now = Date.now();
    const fresh: Record<string, number> = {};
    if (prevCounts.current) {
      for (const n of graph.nodes) {
        if ((prevCounts.current.get(n.id) ?? 0) < n.count) fresh[n.id] = now;
      }
    }
    if (prevWeights.current) {
      for (const l of graph.links) {
        if ((prevWeights.current.get(l.key) ?? 0) < l.weight) fresh[l.key] = now;
      }
    }
    prevCounts.current = new Map(graph.nodes.map((n) => [n.id, n.count]));
    prevWeights.current = new Map(graph.links.map((l) => [l.key, l.weight]));
    if (Object.keys(fresh).length === 0) return;
    setPulses((p) => ({ ...p, ...fresh }));
    const timer = window.setTimeout(() => {
      setPulses((p) => {
        const next = { ...p };
        for (const k of Object.keys(fresh)) if (next[k] === fresh[k]) delete next[k];
        return next;
      });
    }, 2200);
    return () => window.clearTimeout(timer);
  }, [graph]);

  useEffect(() => {
    const nodes: { id: string; r: number; near?: string[] }[] = graph.nodes.map((n) => ({
      id: n.id,
      r: codeRadius(n.count),
      near: [
        ...neighbours(graph, n.id).map((x) => x.node.id),
        ...(n.parentId ? [n.parentId] : []),
      ],
    }));
    // Strong links pull codes close; a single shared passage barely pulls,
    // so hubs do not drag the whole codebook into one knot.
    const maxW = Math.max(1, ...graph.links.map((l) => l.weight));
    const radius = new Map(nodes.map((n) => [n.id, n.r]));
    const links: SimLink[] = graph.links.map((l) => {
      const share = l.weight / maxW;
      return {
        source: l.source,
        target: l.target,
        distance:
          (radius.get(l.source) ?? 10) + (radius.get(l.target) ?? 10) + 150 - share * 90,
        strength: 0.04 + share * 0.36,
      };
    });
    const present = new Set(graph.nodes.map((n) => n.id));
    for (const n of graph.nodes) {
      if (n.parentId && present.has(n.parentId)) {
        links.push({ source: n.id, target: n.parentId, distance: 120, strength: 0.18 });
      }
    }
    if (showPassages) {
      for (const p of graph.passages) {
        const id = `p:${p.segmentId}`;
        nodes.push({ id, r: 4.5, near: p.codeIds });
        for (const c of p.codeIds) {
          links.push({ source: id, target: c, distance: 46, strength: 0.6 });
        }
      }
    }
    sim.setGraph({ nodes, links });
  }, [graph, showPassages, sim]);

  // One animation loop for the life of the view. It only re-renders while the
  // layout is moving or the camera is still settling.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const moved = sim.tick();
      const settling = dragRef.current ? false : fitCamera(sim, viewRef.current);
      if (moved || settling) setFrame((f) => (f + 1) % 1_000_000);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [sim]);

  const toSvgPoint = (clientX: number, clientY: number) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };

  const onNodePointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { id, moved: false, startX: e.clientX, startY: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
    drag.moved = true;
    const node = sim.nodes.get(drag.id);
    if (!node) return;
    const p = toSvgPoint(e.clientX, e.clientY);
    node.fx = p.x;
    node.fy = p.y;
    sim.reheat(0.25);
  };
  const onPointerUp = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const node = sim.nodes.get(drag.id);
    if (node) {
      node.fx = null;
      node.fy = null;
    }
    if (!drag.moved && !drag.id.startsWith("p:")) {
      onSelect(
        selection?.kind === "code" && selection.id === drag.id ? null : { kind: "code", id: drag.id },
      );
    }
  };

  const focusId = hover ?? (selection?.kind === "code" ? selection.id : null);
  const focusLink = selection?.kind === "link" ? selection.key : null;
  const lit = useMemo(() => {
    if (focusLink) {
      const l = graph.links.find((x) => x.key === focusLink);
      return l ? new Set([l.source, l.target]) : null;
    }
    if (!focusId) return null;
    return new Set([focusId, ...neighbours(graph, focusId).map((x) => x.node.id)]);
  }, [focusId, focusLink, graph]);

  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);
  const v = viewRef.current;
  const maxWeight = Math.max(1, ...graph.links.map((l) => l.weight));
  // User units per screen pixel: text and halos are sized in screen pixels so
  // names stay readable however far the camera has pulled back.
  const px = 1 / Math.min(pane.w / v.w, pane.h / v.h);

  return (
    <div
      ref={paneRef}
      className="absolute inset-0"
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <svg
        ref={svgRef}
        role="img"
        aria-label={`Network of ${graph.nodes.length} codes and ${graph.links.length} connections`}
        viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full select-none"
        onClick={() => onSelect(null)}
      >
        <defs>
          {graph.links.map((l) => {
            const s = sim.nodes.get(l.source);
            const t = sim.nodes.get(l.target);
            const sc = nodeById.get(l.source)?.color ?? "#888";
            const tc = nodeById.get(l.target)?.color ?? "#888";
            if (!s || !t) return null;
            return (
              <linearGradient
                key={l.key}
                id={`map-g-${cssId(l.key)}`}
                gradientUnits="userSpaceOnUse"
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
              >
                <stop offset="0%" stopColor={sc} />
                <stop offset="100%" stopColor={tc} />
              </linearGradient>
            );
          })}
        </defs>

        {/* Sub-code tethers: structure, not evidence, so drawn quietly. */}
        {graph.nodes.map((n) => {
          if (!n.parentId) return null;
          const a = sim.nodes.get(n.id);
          const b = sim.nodes.get(n.parentId);
          if (!a || !b) return null;
          return (
            <line
              key={`tether-${n.id}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="var(--ink-4)"
              strokeWidth={1}
              strokeDasharray="2 4"
              opacity={lit && !(lit.has(n.id) && lit.has(n.parentId)) ? 0.12 : 0.55}
            />
          );
        })}

        {showPassages &&
          graph.passages.map((p) => {
            const pn = sim.nodes.get(`p:${p.segmentId}`);
            if (!pn) return null;
            return p.codeIds.map((c) => {
              const cn = sim.nodes.get(c);
              if (!cn) return null;
              const dim = lit && !lit.has(c);
              return (
                <line
                  key={`pl-${p.segmentId}-${c}`}
                  x1={pn.x}
                  y1={pn.y}
                  x2={cn.x}
                  y2={cn.y}
                  stroke={nodeById.get(c)?.color ?? "var(--ink-4)"}
                  strokeWidth={1}
                  opacity={dim ? 0.08 : 0.4}
                />
              );
            });
          })}

        {graph.links.map((l) => {
          const s = sim.nodes.get(l.source);
          const t = sim.nodes.get(l.target);
          if (!s || !t) return null;
          const on = focusLink === l.key || (focusId && (l.source === focusId || l.target === focusId));
          const dim = (lit || focusLink) && !on;
          const width = 1.6 + (l.weight / maxWeight) * 7;
          return (
            <g key={l.key}>
              {pulses[l.key] && (
                <line
                  key={pulses[l.key]}
                  x1={s.x}
                  y1={s.y}
                  x2={t.x}
                  y2={t.y}
                  stroke={`url(#map-g-${cssId(l.key)})`}
                  strokeWidth={width + 10}
                  strokeLinecap="round"
                  opacity={0.35}
                >
                  <animate attributeName="opacity" from="0.55" to="0" dur="1.8s" fill="freeze" />
                </line>
              )}
              <line
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke={`url(#map-g-${cssId(l.key)})`}
                strokeWidth={width}
                strokeLinecap="round"
                opacity={dim ? 0.1 : on ? 0.95 : 0.55}
                style={{ transition: "opacity 160ms" }}
              />
              {/* Wide invisible hit target, so thin links are still clickable. */}
              <line
                x1={s.x}
                y1={s.y}
                x2={t.x}
                y2={t.y}
                stroke="transparent"
                strokeWidth={Math.max(12, width + 8)}
                className="cursor-pointer"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(focusLink === l.key ? null : { kind: "link", key: l.key });
                }}
              >
                <title>
                  {`${nodeById.get(l.source)?.name} + ${nodeById.get(l.target)?.name}: ${l.weight} shared passage${l.weight === 1 ? "" : "s"}`}
                </title>
              </line>
            </g>
          );
        })}

        {showPassages &&
          graph.passages.map((p) => {
            const pn = sim.nodes.get(`p:${p.segmentId}`);
            if (!pn) return null;
            const dim = lit && !p.codeIds.some((c) => lit.has(c));
            return (
              <circle
                key={`p-${p.segmentId}`}
                cx={pn.x}
                cy={pn.y}
                r={hoverPassage?.segmentId === p.segmentId ? 6 : 4}
                fill="var(--map-ground)"
                stroke="var(--ink-2)"
                strokeWidth={1.4}
                opacity={dim ? 0.15 : 1}
                className="cursor-pointer"
                onPointerDown={(e) => onNodePointerDown(e, `p:${p.segmentId}`)}
                onPointerEnter={() => setHoverPassage(p)}
                onPointerLeave={() => setHoverPassage(null)}
                onDoubleClick={() => void jumpToPassage(p)}
                onClick={(e) => e.stopPropagation()}
              />
            );
          })}

        {graph.nodes.map((n) => {
          const sn = sim.nodes.get(n.id);
          if (!sn) return null;
          const r = sn.r;
          const dim = lit && !lit.has(n.id);
          const selected = selection?.kind === "code" && selection.id === n.id;
          return (
            <g
              key={n.id}
              transform={`translate(${sn.x} ${sn.y})`}
              opacity={dim ? 0.18 : 1}
              style={{ transition: "opacity 160ms" }}
              className="cursor-pointer"
              onPointerDown={(e) => onNodePointerDown(e, n.id)}
              onPointerEnter={() => setHover(n.id)}
              onPointerLeave={() => setHover(null)}
              onClick={(e) => e.stopPropagation()}
            >
              {pulses[n.id] && (
                <circle
                  key={pulses[n.id]}
                  r={r}
                  fill="none"
                  stroke={n.color}
                  strokeWidth={3}
                  className="map-pulse"
                />
              )}
              {selected && (
                <circle r={r + 5} fill="none" stroke={n.color} strokeWidth={1.5} opacity={0.6} />
              )}
              {/* Opaque ground first, so links end at the rim instead of
                  crossing the count. */}
              <circle r={r} fill="var(--map-ground)" />
              <circle r={r} fill={n.color} fillOpacity={0.16} stroke={n.color} strokeWidth={2} />
              <text
                textAnchor="middle"
                dy="0.35em"
                fontSize={Math.min(13, 8 + r * 0.22)}
                fontWeight={600}
                fill={n.color}
              >
                {n.count}
              </text>
              <title>{`${n.name}: ${n.count} passage${n.count === 1 ? "" : "s"}`}</title>
            </g>
          );
        })}

        {/* Labels in their own layer, above every node, so a neighbour's
            circle never covers a name. */}
        <g pointerEvents="none">
          {graph.nodes.map((n) => {
            const sn = sim.nodes.get(n.id);
            if (!sn) return null;
            const dim = lit && !lit.has(n.id);
            return (
              <text
                key={`label-${n.id}`}
                x={sn.x}
                y={sn.y + sn.r + 13 * px}
                textAnchor="middle"
                className="map-label font-serif"
                fontSize={12.5 * px}
                strokeWidth={4 * px}
                fill="var(--ink)"
                opacity={dim ? 0.2 : 1}
              >
                {truncate(n.name, 28)}
              </text>
            );
          })}
        </g>
      </svg>

      {hoverPassage && (
        <div className="pointer-events-none absolute left-3 top-3 max-w-[340px] rounded-lg border border-[var(--g-rim)] bg-[var(--note-bg)] px-3 py-2 shadow-md">
          <div className="text-[10.5px] text-[var(--ink-4)]">
            {hoverPassage.participantLabel} · {hoverPassage.timestampStart.replace(/\.\d+$/, "")}
          </div>
          <p className="mt-0.5 font-serif text-[13px] leading-snug text-[var(--ink)]">
            “{truncate(hoverPassage.quote, 220)}”
          </p>
          <div className="mt-1 text-[10.5px] text-[var(--ink-4)]">Double-click to open</div>
        </div>
      )}

      <div className="pointer-events-none absolute bottom-2 right-3 text-[10.5px] text-[var(--ink-4)]">
        Line weight = passages shared · drag to arrange
      </div>

      {/* In the canvas, not the header: a header control that only exists
          for one view made the view tabs jump sideways on every switch. */}
      <div className="absolute right-3 top-3">
        <Tooltip
          // Left, with a fixed width: the map always sits at the window's
          // right edge, and a centred tip there shrank to a word per line.
          side="left"
          content={
            <span className="block w-[230px] font-normal leading-snug">
              Draws every coded passage as a small dot, tied to each code it carries.
              Hover a dot to read the passage; double-click to open it.
            </span>
          }
        >
          <button
            type="button"
            role="switch"
            aria-checked={showPassages}
            onClick={() => setShowPassages(!showPassages)}
            className="inline-flex items-center gap-2 rounded-full border border-[var(--g-rim)] bg-[var(--map-ground)] py-1 pl-1.5 pr-2.5 text-[11.5px] text-[var(--ink-2)] shadow-xs transition-colors hover:text-[var(--ink)]"
          >
            <span
              aria-hidden="true"
              className="relative h-3.5 w-6 rounded-full transition-colors"
              style={{ background: showPassages ? "var(--accent)" : "var(--fill-hi)" }}
            >
              <span
                className="absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow-xs transition-[left]"
                style={{ left: showPassages ? "12px" : "2px" }}
              />
            </span>
            Show passages
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function cssId(key: string) {
  return key.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Ease the camera toward the layout's bounds. Returns true while moving. */
function fitCamera(sim: ForceSim, view: ViewBox): boolean {
  const b = sim.bounds();
  if (!b) return false;
  const padX = 90;
  const padTop = 40;
  const padBottom = 60; // labels hang below nodes
  let w = b.maxX - b.minX + padX * 2;
  let h = b.maxY - b.minY + padTop + padBottom;
  // Never zoom in past roughly life size, or a three-code map fills the pane
  // with three enormous circles.
  w = Math.max(w, 560);
  h = Math.max(h, 400);
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2 + (padBottom - padTop) / 2;
  const target = { x: cx - w / 2, y: cy - h / 2, w, h };
  let moving = false;
  for (const k of ["x", "y", "w", "h"] as const) {
    const d = target[k] - view[k];
    if (Math.abs(d) > 0.3) {
      view[k] += d * 0.12;
      moving = true;
    }
  }
  return moving;
}

// ── Timeline ────────────────────────────────────────────────────────────────

function TimelineView({
  graph,
  interviews,
  segmentIndex,
  selectedCodeId,
  onSelectCode,
}: {
  graph: RelationshipGraph;
  interviews: Interview[];
  segmentIndex: Map<string, number>;
  selectedCodeId: string | null;
  onSelectCode: (id: string | null) => void;
}) {
  const rows = useMemo(
    () => buildTimeline(graph, interviews, segmentIndex),
    [graph, interviews, segmentIndex],
  );
  const passageById = useMemo(
    () => new Map(graph.passages.map((p) => [p.segmentId, p])),
    [graph],
  );
  const [hover, setHover] = useState<{ p: MapPassage; x: number; y: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  if (rows.length === 0) {
    return (
      <div className="grid h-full place-items-center text-[12px] text-[var(--ink-3)]">
        Loading transcript positions…
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="absolute inset-0 overflow-auto px-4 pb-16 pt-3"
      onClick={() => onSelectCode(null)}
    >
      {rows.map(({ interview, lanes }) => (
        <div key={interview.id} className="mb-6">
          <div className="mb-2 flex items-baseline justify-between">
            <span className="text-[12px] font-semibold text-[var(--ink-2)]">
              {interview.participant_label}
            </span>
            <span className="text-[10.5px] text-[var(--ink-4)]">start → end of interview</span>
          </div>
          <div className="space-y-1">
            {lanes.map((lane) => {
              const dim = selectedCodeId && selectedCodeId !== lane.code.id;
              return (
                <div
                  key={lane.code.id}
                  className="grid items-center gap-3"
                  style={{ gridTemplateColumns: "minmax(110px, 30%) 1fr", opacity: dim ? 0.3 : 1 }}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onSelectCode(selectedCodeId === lane.code.id ? null : lane.code.id);
                    }}
                    className="flex min-w-0 items-center gap-1.5 text-left text-[11.5px] text-[var(--ink-2)] hover:text-[var(--ink)]"
                    title={lane.code.name}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ background: lane.code.color }}
                    />
                    <span className="truncate">{lane.code.name}</span>
                  </button>
                  <div className="relative h-5 rounded bg-[var(--fill)]">
                    {lane.marks.map((m) => {
                      const p = passageById.get(m.segmentId);
                      return (
                        <button
                          key={m.segmentId}
                          type="button"
                          aria-label={`Open passage in ${interview.participant_label}`}
                          className="absolute top-0.5 h-4 w-[7px] -translate-x-1/2 rounded-[2px] transition-transform hover:scale-y-125"
                          style={{ left: `${m.at * 100}%`, background: lane.code.color }}
                          onPointerEnter={(e) => {
                            const root = rootRef.current;
                            if (!p || !root) return;
                            const box = root.getBoundingClientRect();
                            const r = e.currentTarget.getBoundingClientRect();
                            setHover({
                              p,
                              x: r.left - box.left + root.scrollLeft,
                              y: r.bottom - box.top + root.scrollTop,
                            });
                          }}
                          onPointerLeave={() => setHover(null)}
                          onClick={(e) => {
                            e.stopPropagation();
                            if (p) void jumpToPassage(p);
                          }}
                        />
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 max-w-[300px] rounded-lg border border-[var(--g-rim)] bg-[var(--note-bg)] px-3 py-2 shadow-md"
          style={{ left: Math.max(8, hover.x - 140), top: hover.y + 6 }}
        >
            <div className="text-[10.5px] text-[var(--ink-4)]">
              {hover.p.timestampStart.replace(/\.\d+$/, "")} · click to open
            </div>
            <p className="mt-0.5 font-serif text-[12.5px] leading-snug text-[var(--ink)]">
              “{truncate(hover.p.quote, 180)}”
            </p>
        </div>
      )}
    </div>
  );
}

// ── Structure ───────────────────────────────────────────────────────────────

function StructureView({
  graph,
  title,
  selectedCodeId,
  onSelectCode,
}: {
  graph: RelationshipGraph;
  title: string;
  selectedCodeId: string | null;
  onSelectCode: (id: string | null) => void;
}) {
  const codes = useDisplayCodes();
  const themes = useMemo(() => buildStructure(graph, codes), [graph, codes]);
  const hasChildren = themes.some((t) => t.children.length > 0);
  const R1 = hasChildren ? 135 : 190;
  const R2 = 255;

  const placed = useMemo(() => {
    const weights = themes.map((t) => Math.max(1, t.children.length));
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    let cursor = -Math.PI / 2;
    return themes.map((t, i) => {
      const span = (weights[i] / total) * Math.PI * 2;
      const mid = cursor + span / 2;
      const children = t.children.map((c, j) => {
        const a =
          t.children.length === 1 ? mid : cursor + (span * (j + 0.5)) / t.children.length;
        return { node: c, angle: a };
      });
      cursor += span;
      return { theme: t, angle: mid, children };
    });
  }, [themes]);

  const pos = (angle: number, r: number) => ({ x: Math.cos(angle) * r, y: Math.sin(angle) * r });
  const extent = (hasChildren ? R2 : R1) + 165;
  const nodeR = (n: MapNode) => (n.count > 0 ? 5 + Math.sqrt(n.count) * 3.2 : 4.5);

  const label = (n: MapNode, angle: number, r: number) => {
    const deg = (angle * 180) / Math.PI;
    const left = Math.cos(angle) < -0.0001;
    const p = pos(angle, r);
    return (
      <text
        x={p.x}
        y={p.y}
        dy="0.33em"
        transform={`rotate(${left ? deg + 180 : deg} ${p.x} ${p.y})`}
        textAnchor={left ? "end" : "start"}
        className="map-label font-serif"
        fontSize={15}
        strokeWidth={5}
        fill={n.count > 0 ? "var(--ink)" : "var(--ink-4)"}
      >
        {truncate(n.name, 30)}
        {n.count > 0 && (
          <tspan fill="var(--ink-4)" fontSize={12}>
            {" "}
            {n.count}
          </tspan>
        )}
      </text>
    );
  };

  const dot = (n: MapNode, x: number, y: number) => {
    const r = nodeR(n);
    const dim = selectedCodeId && selectedCodeId !== n.id;
    return (
      <g
        key={n.id}
        className="cursor-pointer"
        opacity={dim ? 0.35 : 1}
        onClick={(e) => {
          e.stopPropagation();
          onSelectCode(selectedCodeId === n.id || n.count === 0 ? null : n.id);
        }}
      >
        {selectedCodeId === n.id && (
          <circle cx={x} cy={y} r={r + 4} fill="none" stroke={n.color} strokeWidth={1.5} />
        )}
        <circle
          cx={x}
          cy={y}
          r={r}
          fill={n.count > 0 ? n.color : "var(--map-ground)"}
          stroke={n.color}
          strokeWidth={1.6}
          strokeDasharray={n.count > 0 ? undefined : "2 2"}
        />
        <title>{n.count > 0 ? `${n.name}: ${n.count} passages` : `${n.name}: not used yet`}</title>
      </g>
    );
  };

  return (
    <div className="absolute inset-0" onClick={() => onSelectCode(null)}>
      <svg
        viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
        preserveAspectRatio="xMidYMid meet"
        className="h-full w-full"
        role="img"
        aria-label="Codebook structure"
      >
        {placed.map(({ theme, angle, children }) => {
          const a = pos(angle, R1);
          return (
            <g key={theme.node.id}>
              <path
                d={`M0 0 Q ${pos(angle, R1 * 0.5).x} ${pos(angle, R1 * 0.5).y} ${a.x} ${a.y}`}
                fill="none"
                stroke={theme.node.color}
                strokeOpacity={0.35}
                strokeWidth={1 + Math.sqrt(theme.rollup) * 0.9}
              />
              {children.map(({ node, angle: ca }) => {
                const c = pos(ca, R2);
                const mid = pos((angle + ca) / 2, (R1 + R2) / 2);
                return (
                  <path
                    key={node.id}
                    d={`M${a.x} ${a.y} Q ${mid.x} ${mid.y} ${c.x} ${c.y}`}
                    fill="none"
                    stroke={node.color}
                    strokeOpacity={node.count > 0 ? 0.45 : 0.2}
                    strokeWidth={1 + Math.sqrt(node.count) * 0.7}
                  />
                );
              })}
            </g>
          );
        })}
        <circle r={44} fill="var(--map-ground)" stroke="var(--g-rim)" />
        <text textAnchor="middle" dy="0.33em" fontSize={13} fill="var(--ink-2)" className="font-serif">
          {truncate(title, 16)}
        </text>
        {placed.map(({ theme, angle, children }) => {
          const a = pos(angle, R1);
          const r = nodeR(theme.node);
          return (
            <g key={`n-${theme.node.id}`}>
              {dot(theme.node, a.x, a.y)}
              {children.length > 0 ? (
                // Level labels for themes: a radial one would run straight
                // through the theme's own sub-code branches.
                <text
                  x={a.x}
                  y={a.y - r - 8}
                  textAnchor="middle"
                  className="map-label font-serif"
                  fontSize={16}
                  fontWeight={600}
                  strokeWidth={6}
                  fill="var(--ink)"
                >
                  {truncate(theme.node.name, 26)}
                </text>
              ) : (
                label(theme.node, angle, R1 + r + 6)
              )}
              {children.map(({ node, angle: ca }) => {
                const c = pos(ca, R2);
                return (
                  <g key={`c-${node.id}`}>
                    {dot(node, c.x, c.y)}
                    {label(node, ca, R2 + nodeR(node) + 6)}
                  </g>
                );
              })}
            </g>
          );
        })}
      </svg>
      <div className="pointer-events-none absolute bottom-2 right-3 text-[10.5px] text-[var(--ink-4)]">
        Themes inner ring · sub-codes outer · hollow = not used yet
      </div>
    </div>
  );
}

// ── Detail card ─────────────────────────────────────────────────────────────

function DetailCard({
  graph,
  node,
  link,
  onSelect,
}: {
  graph: RelationshipGraph;
  node: MapNode | null;
  link: MapLink | null;
  onSelect: (s: Selection) => void;
}) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const passages = link
    ? graph.passages.filter((p) => link.passageIds.includes(p.segmentId))
    : node
      ? graph.passages.filter((p) => p.codeIds.includes(node.id))
      : [];
  const related = node ? neighbours(graph, node.id) : [];
  const a = link ? byId.get(link.source) : null;
  const b = link ? byId.get(link.target) : null;

  return (
    <aside
      className="absolute bottom-3 left-3 flex max-h-[46%] w-[min(380px,calc(100%-24px))] flex-col overflow-hidden rounded-xl border border-[var(--g-rim)] bg-[var(--note-bg)] shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-start gap-2 border-b border-[var(--g-rim)] px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          {node && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: node.color }} />
                <span className="truncate font-serif text-[14px] text-[var(--ink)]">{node.name}</span>
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--ink-3)]">
                {node.count} passage{node.count === 1 ? "" : "s"} · connected to {related.length} code
                {related.length === 1 ? "" : "s"}
              </div>
              {node.definition && (
                <p className="mt-1 text-[11.5px] leading-snug text-[var(--ink-2)]">{node.definition}</p>
              )}
            </>
          )}
          {link && a && b && (
            <>
              <div className="flex flex-wrap items-center gap-1.5 font-serif text-[14px] text-[var(--ink)]">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: a.color }} />
                {a.name}
                <span className="text-[var(--ink-4)]">+</span>
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: b.color }} />
                {b.name}
              </div>
              <div className="mt-0.5 text-[11px] text-[var(--ink-3)]">
                Together on {link.weight} passage{link.weight === 1 ? "" : "s"}
              </div>
            </>
          )}
        </div>
        <button
          type="button"
          onClick={() => onSelect(null)}
          aria-label="Close details"
          className="grid h-5 w-5 shrink-0 place-items-center rounded text-[var(--ink-4)] hover:bg-[var(--fill)] hover:text-[var(--ink)]"
        >
          <Icon name="close" size={11} />
        </button>
      </div>

      <div className="min-h-0 overflow-y-auto px-3.5 py-2">
        {related.length > 0 && (
          <div className="mb-2">
            <div className="eyebrow mb-1">Shares passages with</div>
            <div className="flex flex-wrap gap-1">
              {related.map(({ node: other, link: l }) => (
                <button
                  key={other.id}
                  type="button"
                  onClick={() => onSelect({ kind: "link", key: l.key })}
                  className="inline-flex items-center gap-1 rounded-full border border-[var(--g-rim)] px-2 py-0.5 text-[11px] text-[var(--ink-2)] hover:bg-[var(--fill)]"
                >
                  <span className="h-1.5 w-1.5 rounded-full" style={{ background: other.color }} />
                  {truncate(other.name, 24)}
                  <span className="text-[var(--ink-4)]">{l.weight}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="eyebrow mb-1">Passages</div>
        <ul className="space-y-1">
          {passages.slice(0, 30).map((p) => (
            <li key={p.segmentId}>
              <button
                type="button"
                onClick={() => void jumpToPassage(p)}
                className="w-full rounded-md px-2 py-1.5 text-left hover:bg-[var(--fill)]"
                title="Open this passage in the transcript"
              >
                <div className="text-[10.5px] text-[var(--ink-4)]">
                  {p.participantLabel} · {p.timestampStart.replace(/\.\d+$/, "")}
                </div>
                <p className="line-clamp-3 font-serif text-[12.5px] leading-snug text-[var(--ink)]">
                  “{p.quote}”
                </p>
              </button>
            </li>
          ))}
        </ul>
        {passages.length > 30 && (
          <p className="px-2 py-1 text-[11px] text-[var(--ink-4)]">
            and {passages.length - 30} more
          </p>
        )}
      </div>
    </aside>
  );
}
