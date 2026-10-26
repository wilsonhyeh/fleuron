import { open } from "@tauri-apps/plugin-dialog";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../store/project-store";
import { isDraftDirty, useNoteDraftStore } from "../store/note-draft-store";
import { useAutosaveMemo } from "../hooks/useAutosaveMemo";
import { useAppStore } from "../store/app-store";
import { appConfirm } from "../store/confirm-store";
import { formatTimestampDisplay } from "../lib/vtt-parser";
import { NewInterviewModal } from "./NewInterviewModal";
import { BulkImportModal } from "./BulkImportModal";
import { InterviewSettingsModal } from "./InterviewSettingsModal";
import { ManageSpeakersModal } from "./ManageSpeakersModal";
import { TranscriptLinkPanel } from "./TranscriptLinkPanel";
import { api } from "../lib/api";
import { codeWithSubCodes } from "../lib/code-search";
import { groupPassageChips, nextCoding } from "../lib/passage-chips";
import {
  highlightRuns,
  selectionOffsets,
  clickOffsetIn,
  extendSpan,
  formatRunAttribution,
  matchRanges,
  splitRunsOnMatches,
  inlineMark,
  underlineLayer,
  MARK_THICKNESS_PX,
  type InlineMark,
  type MatchRange,
} from "../lib/highlight";
import { resolveClickedCoding } from "../lib/coding-target";
import {
  normalizeZoom,
  stepZoom,
  zoomPercent,
  ZOOM_MAX,
  ZOOM_MIN,
} from "../lib/reading-zoom";
import { hasModKey } from "../lib/platform";
import {
  useSpeakerDisplay,
  useSpeakerRedactionOn,
} from "../hooks/useSpeakerDisplay";
import { aliasPreview } from "../lib/speaker-alias";
import { SelectionBubble, type BubbleAnchor } from "./SelectionBubble";
import { SpeakerPickerPopover } from "./SpeakerPickerPopover";
import { buildMarkMenuItems } from "./TranscriptPanel.menu";
import { NoteConflictModal } from "./NoteConflictModal";
import { modKey } from "../lib/platform";
import { THEME_GROUND, usePrefersDark } from "../hooks/useTheme";
import { computeStripeLayout, type StripeLayoutResult } from "../lib/stripe-layout";
import { Icon } from "./ui/Icon";
import { FilterButton } from "./FilterButton";
import { InterviewHistoryNav } from "./InterviewHistoryNav";
import { openContextMenu } from "./ui/ContextMenu";
import { readableOn } from "../lib/code-colors";
import {
  scrollFraction,
  scrollPlan,
  scrollTopForFraction,
} from "../lib/scroll-into-view";
import type { Code, CodedSegment, Interview, TranscriptSegment } from "../lib/types";

const EMPTY_CODINGS: CodedSegment[] = [];
const EMPTY_MATCHES: MatchRange[] = [];

export function TranscriptPanel() {
  const {
    segments,
    selectedSegmentId,
    setSelectedSegmentId,
    selectionIntent,
    codedSegments,
    codes,
    activeInterviewId,
    interviews,
    importVtt,
    createInterview,
    selectInterview,
    transcriptSearch,
    setTranscriptSearch,
    renameInterview,
    deleteInterview,
    interviewDeleteImpact,
    activeCoder,
    removeCodedSegment,
    showStatus,
    openNoteForCoding,
    removeCodeFromCoding,
    clearMemoForCoding,
    setPendingSelection,
    pendingSpan,
    codeFilter,
    codeFilterIds,
    filterMatchMode,
    toggleCodeFilter,
    setCodeFilters,
    setFilterMatchMode,
    clearAllFilters,
    setCodeFilter,
    speakerFilter,
    setSpeakerFilter,
    reviewedBySegment,
    setSegmentReviewed,
    setSegmentSpeaker,
  } = useProjectStore(
    useShallow((s) => ({
      segments: s.segments,
      selectedSegmentId: s.selectedSegmentId,
      setSelectedSegmentId: s.setSelectedSegmentId,
      selectionIntent: s.selectionIntent,
      codedSegments: s.codedSegments,
      codes: s.codes,
      activeInterviewId: s.activeInterviewId,
      interviews: s.interviews,
      importVtt: s.importVtt,
      createInterview: s.createInterview,
      selectInterview: s.selectInterview,
      transcriptSearch: s.transcriptSearch,
      setTranscriptSearch: s.setTranscriptSearch,
      renameInterview: s.renameInterview,
      deleteInterview: s.deleteInterview,
      interviewDeleteImpact: s.interviewDeleteImpact,
      activeCoder: s.activeCoder,
      removeCodedSegment: s.removeCodedSegment,
      showStatus: s.showStatus,
      openNoteForCoding: s.openNoteForCoding,
      removeCodeFromCoding: s.removeCodeFromCoding,
      clearMemoForCoding: s.clearMemoForCoding,
      setPendingSelection: s.setPendingSelection,
      pendingSpan: s.pendingSelection,
      codeFilter: s.codeFilter,
      codeFilterIds: s.codeFilterIds,
      filterMatchMode: s.filterMatchMode,
      toggleCodeFilter: s.toggleCodeFilter,
      setCodeFilters: s.setCodeFilters,
      setFilterMatchMode: s.setFilterMatchMode,
      clearAllFilters: s.clearAllFilters,
      setCodeFilter: s.setCodeFilter,
      speakerFilter: s.speakerFilter,
      setSpeakerFilter: s.setSpeakerFilter,
      reviewedBySegment: s.reviewedBySegment,
      setSegmentReviewed: s.setSegmentReviewed,
      setSegmentSpeaker: s.setSegmentSpeaker,
    })),
  );
  const intent = useAppStore((s) => s.intent);
  const setIntent = useAppStore((s) => s.setIntent);
  const transcriptZoomPref = useAppStore((s) => s.preferences.transcript_zoom);
  const setTranscriptZoom = useAppStore((s) => s.setTranscriptZoom);
  const zoom = normalizeZoom(transcriptZoomPref);
  const showSpeaker = useSpeakerDisplay();
  const redactionOn = useSpeakerRedactionOn();
  const setSpeakerRedaction = useAppStore((s) => s.setSpeakerRedaction);

  const [importing, setImporting] = useState(false);
  const [showNewInterview, setShowNewInterview] = useState(false);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showLinkPanel, setShowLinkPanel] = useState(false);
  const [pendingCoded, setPendingCoded] = useState(0);
  const [editingInterview, setEditingInterview] = useState<Interview | null>(null);
  const [managingSpeakersInterview, setManagingSpeakersInterview] =
    useState<Interview | null>(null);
  const [speakerPopoverSegment, setSpeakerPopoverSegment] =
    useState<TranscriptSegment | null>(null);
  const [speakerPopoverRect, setSpeakerPopoverRect] = useState<DOMRect | null>(
    null,
  );
  const speakerButtonRef = useRef<HTMLButtonElement | null>(null);

  const openSpeakerPopover = (
    seg: TranscriptSegment,
    target: HTMLButtonElement,
  ) => {
    speakerButtonRef.current = target;
    setSpeakerPopoverSegment(seg);
    setSpeakerPopoverRect(target.getBoundingClientRect());
  };

  const closeSpeakerPopover = () => {
    setSpeakerPopoverSegment(null);
    setSpeakerPopoverRect(null);
    speakerButtonRef.current?.focus();
  };
  const [hoveredPillCodeId, setHoveredPillCodeId] = useState<string | null>(null);
  const [flashCodeId, setFlashCodeId] = useState<string | null>(null);
  const articleRefs = useRef<Map<string, HTMLElement>>(new Map());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [bubbleAnchor, setBubbleAnchor] = useState<BubbleAnchor | null>(null);
  /**
   * Fixed edge for Shift+click extension (T01). Set when a plain drag creates
   * a pending span; the anchor stays put while Shift+click moves the focus
   * edge. Cleared together with the pending selection.
   */
  const anchorRef = useRef<{ segmentId: string; anchor: number } | null>(null);

  /**
   * Span capture lives at the document level.
   * Cross-passage selection triggers a helpful notice (B4).
   */
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      // Shift+click extension is handled in the passage onClick below, where
      // the stored anchor is known. Letting this handler run first would
      // overwrite the pending span with the native extended range and lose
      // which edge is fixed.
      if (e.shiftKey) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      const node =
        range.commonAncestorContainer instanceof Element
          ? range.commonAncestorContainer
          : range.commonAncestorContainer.parentElement;
      const article = node?.closest('[role="option"]');
      const p = article?.querySelector("p");

      if (!article || !p) {
        // Check if drag crossed passages inside transcript listbox (B4)
        const inTranscript = node?.closest('[role="listbox"]');
        if (inTranscript) {
          showStatus("A coded span has to sit inside one speaker turn.", "info");
        }
        return;
      }

      const segmentId = article.id.replace(/^segment-/, "");
      const offsets = selectionOffsets(p);
      if (!offsets) return;

      const box = p.getBoundingClientRect();
      const r = range.getBoundingClientRect();
      setPendingSelection({ segmentId, ...offsets });
      anchorRef.current = { segmentId, anchor: offsets.start };
      setBubbleAnchor({
        segmentId,
        rel: {
          top: r.top - box.top,
          left: r.left - box.left,
          bottom: r.bottom - box.top,
        },
      });
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [setPendingSelection, showStatus]);

  useEffect(() => {
    if (bubbleAnchor && bubbleAnchor.segmentId !== selectedSegmentId) {
      setBubbleAnchor(null);
      setPendingSelection(null);
      anchorRef.current = null;
    }
  }, [selectedSegmentId, bubbleAnchor, setPendingSelection]);

  // The anchor only means something while a pending span is alive. Every
  // dismissal path (bubble dismiss, Esc, passage switch) nulls the pending
  // selection, so tying the anchor's lifetime to it keeps the two from
  // disagreeing without touching each call site.
  useEffect(() => {
    if (!pendingSpan) anchorRef.current = null;
  }, [pendingSpan]);

  /**
   * Reader's place (T02/T03): the selected passage plus the scroll fraction,
   * refreshed on selection change and on every scroll so a filter change
   * always has a pre-change snapshot to restore. The fraction — not pixels —
   * survives the list-height change a filter causes.
   */
  const placeRef = useRef<{
    selectedSegmentId: string | null;
    fraction: number;
  }>({ selectedSegmentId: null, fraction: 0 });

  // Holds the exact place in the UNFILTERED transcript so clearing a filter
  // never inherits the clamped fraction/height of the filtered view.
  const preFilterPlaceRef = useRef<{
    selectedSegmentId: string | null;
    fraction: number;
  }>({ selectedSegmentId: null, fraction: 0 });

  useEffect(() => {
    placeRef.current.selectedSegmentId = selectedSegmentId;
    if (codeFilterIds.length === 0 && !speakerFilter) {
      preFilterPlaceRef.current.selectedSegmentId = selectedSegmentId;
    }
  }, [selectedSegmentId, codeFilterIds, speakerFilter]);

  const recordScrollPlace = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const curSeg = useProjectStore.getState().selectedSegmentId;
    const frac = scrollFraction(el.scrollTop, el.scrollHeight, el.clientHeight);
    placeRef.current = {
      selectedSegmentId: curSeg,
      fraction: frac,
    };
    if (codeFilterIds.length === 0 && !speakerFilter) {
      preFilterPlaceRef.current = {
        selectedSegmentId: curSeg,
        fraction: frac,
      };
    }
  }, [codeFilterIds, speakerFilter]);

  const filterKey = `${codeFilterIds.join(",")}\n${filterMatchMode}\n${speakerFilter ?? ""}`;
  const filterKeyRef = useRef<string | null>(null);
  const placeInterviewRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedSegmentId) return;
    const el = articleRefs.current.get(selectedSegmentId);
    const scroller = scrollerRef.current;
    if (!el || !scroller) return;

    const elRect = el.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const elTop = scroller.scrollTop + (elRect.top - scrollerRect.top);
    const elHeight = elRect.height;
    const viewportHeight = scrollerRect.height;

    const targetScrollTop = scrollPlan({
      elTop,
      elHeight,
      scrollTop: scroller.scrollTop,
      viewportHeight,
      intent: selectionIntent,
    });

    if (targetScrollTop === null) return;

    if (selectionIntent === "restore") {
      scroller.scrollTop = targetScrollTop;
    } else {
      scroller.scrollTo({ top: targetScrollTop, behavior: "smooth" });
    }
  }, [selectedSegmentId, selectionIntent]);

  useEffect(() => {
    let live = true;
    api
      .pendingCodedCount()
      .then((n) => live && setPendingCoded(n))
      .catch(() => live && setPendingCoded(0));
    return () => {
      live = false;
    };
  }, [segments.length, activeInterviewId]);

  const activeInterview = interviews.find((i) => i.id === activeInterviewId);

  async function pickVttAndImport(targetInterviewId?: string) {
    if (targetInterviewId && targetInterviewId !== activeInterviewId) {
      await selectInterview(targetInterviewId);
    }
    const file = await open({
      multiple: false,
      filters: [
        {
          name: "Transcripts",
          extensions: ["vtt", "srt", "txt", "md", "csv", "tsv", "docx"],
        },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (!file || typeof file !== "string") return;
    setImporting(true);
    try {
      // importVtt raises the success notice itself; a second one here
      // announced the same import twice.
      await importVtt(file);
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), "error");
    } finally {
      setImporting(false);
    }
  }

  async function handleImportVtt() {
    const interviewId = useProjectStore.getState().activeInterviewId;
    if (!interviewId) {
      setShowNewInterview(true);
      return;
    }
    await pickVttAndImport(interviewId);
  }

  const importRef = useRef(handleImportVtt);
  importRef.current = handleImportVtt;
  useEffect(() => {
    if (intent === "import-vtt") {
      setIntent(null);
      importRef.current();
    } else if (intent === "new-interview") {
      setIntent(null);
      setShowNewInterview(true);
    }
  }, [intent, setIntent]);

  async function handleNewInterviewConfirm(label: string) {
    setShowNewInterview(false);
    setImporting(true);
    try {
      const interview = await createInterview(
        label,
        new Date().toISOString().slice(0, 10),
      );
      await pickVttAndImport(interview.id);
    } catch (err) {
      showStatus(err instanceof Error ? err.message : String(err), "error");
      setImporting(false);
    }
  }

  const codedBySegment = useMemo(() => {
    const map = new Map<string, typeof codedSegments>();
    for (const c of codedSegments) {
      const list = map.get(c.segment_id);
      if (list) list.push(c);
      else map.set(c.segment_id, [c]);
    }
    return map;
  }, [codedSegments]);

  const codesById = useMemo(
    () => new Map(codes.map((c) => [c.id, c])),
    [codes],
  );

  const search = transcriptSearch.trim();
  const visibleSegments = useMemo(() => {
    // A filter on a parent also matches its sub-codes: a sub-code never
    // requires the parent on the passage.
    const filterSets = codeFilterIds.map((id) => codeWithSubCodes(id, codes));
    const matches = (turnCodes: Set<string>, ids: Set<string>) =>
      [...ids].some((id) => turnCodes.has(id));
    return segments.filter((seg) => {
      if (filterSets.length > 0) {
        const here = codedBySegment.get(seg.id) ?? [];
        const turnCodes = new Set<string>();
        for (const c of here) {
          for (const cid of c.code_ids) {
            turnCodes.add(cid);
          }
        }
        if (filterMatchMode === "all") {
          if (!filterSets.every((ids) => matches(turnCodes, ids))) return false;
        } else {
          if (!filterSets.some((ids) => matches(turnCodes, ids))) return false;
        }
      }
      if (speakerFilter) {
        if (seg.speaker !== speakerFilter) return false;
      }
      return true;
    });
  }, [segments, codes, codeFilterIds, filterMatchMode, speakerFilter, codedBySegment]);

  const allMatches = useMemo(() => {
    const q = search;
    if (!q) return [];
    const list: { segmentId: string; start: number; end: number; matchIndex: number }[] = [];
    let idx = 0;
    for (const seg of visibleSegments) {
      const ranges = matchRanges(seg.text, q);
      for (const r of ranges) {
        list.push({ segmentId: seg.id, start: r.start, end: r.end, matchIndex: idx++ });
      }
    }
    return list;
  }, [visibleSegments, search]);

  const matchesBySegment = useMemo(() => {
    const map = new Map<string, MatchRange[]>();
    for (const m of allMatches) {
      const list = map.get(m.segmentId);
      if (list) list.push({ start: m.start, end: m.end });
      else map.set(m.segmentId, [{ start: m.start, end: m.end }]);
    }
    return map;
  }, [allMatches]);

  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [search, activeInterviewId, codeFilterIds, filterMatchMode, speakerFilter]);

  useEffect(() => {
    // Filtering keeps your place (T02/T03). First run just arms the key;
    // interview switches keep their own behavior (each interview has its own
    // saved selection). Search-only changes never reach this effect's key.
    if (filterKeyRef.current === null) {
      filterKeyRef.current = filterKey;
      placeInterviewRef.current = activeInterviewId;
      return;
    }
    if (placeInterviewRef.current !== activeInterviewId) {
      placeInterviewRef.current = activeInterviewId;
      filterKeyRef.current = filterKey;
      return;
    }
    if (filterKeyRef.current === filterKey) return;
    filterKeyRef.current = filterKey;

    const snap = preFilterPlaceRef.current;
    if (!snap) return;

    const stillVisible =
      snap.selectedSegmentId !== null &&
      visibleSegments.some((seg) => seg.id === snap.selectedSegmentId);

    if (stillVisible && snap.selectedSegmentId) {
      const segId = snap.selectedSegmentId;
      setSelectedSegmentId(segId, "restore");
      requestAnimationFrame(() => {
        const el =
          articleRefs.current.get(segId) ??
          document.getElementById(`segment-${segId}`);
        const scroller = scrollerRef.current;
        if (el && scroller) {
          const elRect = el.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          const elTop = scroller.scrollTop + (elRect.top - scrollerRect.top);
          const targetScrollTop = scrollPlan({
            elTop,
            elHeight: elRect.height,
            scrollTop: scroller.scrollTop,
            viewportHeight: scrollerRect.height,
            intent: "restore",
          });
          if (targetScrollTop !== null) {
            scroller.scrollTop = targetScrollTop;
          }
        }
      });
    } else {
      const fraction = snap.fraction;
      requestAnimationFrame(() => {
        const el = scrollerRef.current;
        if (el) {
          el.scrollTop = scrollTopForFraction(
            fraction,
            el.scrollHeight,
            el.clientHeight,
          );
        }
      });
    }
  }, [filterKey, activeInterviewId, visibleSegments, setSelectedSegmentId]);

  const totalMatches = allMatches.length;
  const activeMatch =
    totalMatches > 0
      ? allMatches[Math.min(currentMatchIndex, totalMatches - 1)]
      : null;

  const goNextMatch = useCallback(() => {
    if (totalMatches === 0) return;
    setCurrentMatchIndex((i) => (i + 1) % totalMatches);
  }, [totalMatches]);

  const goPrevMatch = useCallback(() => {
    if (totalMatches === 0) return;
    setCurrentMatchIndex((i) => (i - 1 + totalMatches) % totalMatches);
  }, [totalMatches]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
      const isCmdF = hasModKey(e) && !e.shiftKey && (e.key === "f" || e.key === "F");
      const isCmdG = isMac && hasModKey(e) && (e.key === "g" || e.key === "G");
      const isF3 = e.key === "F3";

      if (isCmdF) {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (isCmdG || isF3) {
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        if (e.shiftKey) {
          goPrevMatch();
        } else {
          goNextMatch();
        }
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goNextMatch, goPrevMatch]);

  // Passage-text zoom keys (T03): Cmd/Ctrl + +/-/0 while the transcript has
  // focus. Never fires inside inputs, the note editor, or dialogs.
  useEffect(() => {
    const onZoomKey = (e: KeyboardEvent) => {
      if (!hasModKey(e) || e.shiftKey || e.altKey) return;
      if (e.key !== "+" && e.key !== "=" && e.key !== "-" && e.key !== "0") {
        return;
      }
      if (document.querySelector('[role="dialog"]')) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (!target?.closest?.('[data-testid="transcript-panel"]')) return;
      e.preventDefault();
      const current = normalizeZoom(
        useAppStore.getState().preferences.transcript_zoom,
      );
      const setZoom = useAppStore.getState().setTranscriptZoom;
      if (e.key === "0") {
        if (current !== 1) void setZoom(null);
      } else {
        void setZoom(stepZoom(current, e.key === "-" ? -1 : 1));
      }
    };
    window.addEventListener("keydown", onZoomKey);
    return () => window.removeEventListener("keydown", onZoomKey);
  }, []);

  useEffect(() => {
    if (!activeMatch) return;
    const article = articleRefs.current.get(activeMatch.segmentId);
    if (!article) return;
    const mark =
      article.querySelector<HTMLElement>(
        `[data-run-start="${activeMatch.start}"]`,
      ) || article;
    mark.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }, [activeMatch]);

  const clearPassageSelection = () => {
    setPendingSelection(null);
    setSelectedSegmentId(null);
    setBubbleAnchor(null);
    anchorRef.current = null;
    window.getSelection()?.removeAllRanges();
  };

  // Which span a passage chip opened last, so the next click on the same chip
  // opens the following span.
  const lastChipCodingRef = useRef<{ chipKey: string; codingId: string } | null>(null);

  const selectCoding = useCallback(
    (coding: CodedSegment, codeId?: string) => {
      const seg = segments.find((s) => s.id === coding.segment_id);
      if (coding.char_start != null && coding.char_end != null && seg) {
        setPendingSelection({
          segmentId: coding.segment_id,
          start: coding.char_start,
          end: coding.char_end,
          text: seg.text.slice(coding.char_start, coding.char_end),
        });
        anchorRef.current = {
          segmentId: coding.segment_id,
          anchor: coding.char_start,
        };
      } else {
        setPendingSelection(null);
        anchorRef.current = null;
      }
      setSelectedSegmentId(coding.segment_id, "click");
      setBubbleAnchor({ segmentId: coding.segment_id, rel: null });

      const targetCodeId = codeId ?? coding.code_ids[0];
      if (targetCodeId) {
        setFlashCodeId(targetCodeId);
        window.setTimeout(() => setFlashCodeId(null), 150);
      }
    },
    [segments, setSelectedSegmentId, setPendingSelection, setBubbleAnchor],
  );

  const onListKeyDown = (e: React.KeyboardEvent) => {
    // The inline note editor renders inside this list, so its keystrokes
    // bubble here: "n" jumped to the next uncoded passage, "c" opened the
    // code picker and the arrows moved passages instead of the caret — a
    // passage note could not contain either letter. e2e `fill()` sends no
    // keydowns, which is why no test saw it.
    const target = e.target as HTMLElement;
    if (
      target.isContentEditable ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "INPUT" ||
      target.tagName === "SELECT"
    ) {
      return;
    }
    const ids = visibleSegments.map((seg) => seg.id);
    if (ids.length === 0) return;
    const current = selectedSegmentId ? ids.indexOf(selectedSegmentId) : -1;

    const go = (to: number) => {
      e.preventDefault();
      const id = ids[Math.max(0, Math.min(ids.length - 1, to))];
      setSelectedSegmentId(id, "keys");
      articleRefs.current.get(id)?.focus({ preventScroll: true });
    };

    if (e.key === "Escape") {
      e.preventDefault();
      (document.activeElement as HTMLElement | null)?.blur();
      clearPassageSelection();
      return;
    }

    // N / Shift+N jump between uncoded passages (B8)
    if (
      (e.key === "n" || e.key === "N") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey
    ) {
      e.preventDefault();
      const isUncoded = (segId: string) => {
        const codings = codedBySegment.get(segId);
        return !codings || codings.length === 0;
      };

      if (e.shiftKey) {
        let foundIdx = -1;
        const start = current < 0 ? ids.length - 1 : current - 1;
        for (let i = start; i >= 0; i--) {
          if (isUncoded(ids[i])) {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx >= 0) go(foundIdx);
        else showStatus("No previous uncoded passages.", "info");
      } else {
        let foundIdx = -1;
        const start = current < 0 ? 0 : current + 1;
        for (let i = start; i < ids.length; i++) {
          if (isUncoded(ids[i])) {
            foundIdx = i;
            break;
          }
        }
        if (foundIdx >= 0) go(foundIdx);
        else showStatus("No more uncoded passages in this interview.", "info");
      }
      return;
    }

    if (
      (e.key === "c" || e.key === "C") &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      selectedSegmentId
    ) {
      e.preventDefault();
      setPendingSelection(null);
      setBubbleAnchor({ segmentId: selectedSegmentId, rel: null });
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        return go(current < 0 ? 0 : current + 1);
      case "ArrowUp":
        return go(current < 0 ? ids.length - 1 : current - 1);
      case "Home":
        return go(0);
      case "End":
        return go(ids.length - 1);
      case "PageDown":
        return go(Math.min(ids.length - 1, current + 5));
      case "PageUp":
        return go(Math.max(0, current - 5));
    }
  };

  async function copyText(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      showStatus(`Copied ${what.toLowerCase()} to clipboard.`);
    } catch {
      showStatus("Could not reach the clipboard.", "error");
    }
  }

  function segmentMenu(seg: TranscriptSegment) {
    const mine = codedSegments.find(
      (c) => c.segment_id === seg.id && c.coder_name === activeCoder,
    );
    return [
      {
        label: "Code this passage…",
        icon: "code" as const,
        onSelect: () => {
          setPendingSelection(null);
          setBubbleAnchor({ segmentId: seg.id, rel: null });
        },
      },
      {
        label: "Copy passage",
        icon: "note" as const,
        onSelect: () => copyText(seg.text, "Passage"),
      },
      {
        label: "Copy with speaker and timestamp",
        icon: "export" as const,
        onSelect: () =>
          copyText(
            `${showSpeaker(seg.speaker)} (${formatTimestampDisplay(seg.timestamp_start)}): ${seg.text}`,
            "Passage",
          ),
      },
      ...(seg.block_id
        ? [
            {
              label: `Copy block ID ^${seg.block_id}`,
              icon: "code" as const,
              onSelect: () => copyText(`^${seg.block_id}`, "Block ID"),
            },
          ]
        : []),
      ...(mine
        ? [
            {
              label: "Remove my coding here",
              icon: "close" as const,
              onSelect: () => removeCodedSegment(mine.id),
              destructive: true,
            },
          ]
        : []),
    ];
  }

  function interviewOverflowMenu(interview: Interview) {
    const isSingle = interviews.length <= 1;
    return [
      {
        label: "Import several transcripts…",
        icon: "import" as const,
        onSelect: () => setShowBulkImport(true),
      },
      {
        label: "Edit details…",
        icon: "edit" as const,
        onSelect: () => setEditingInterview(interview),
      },
      {
        label: "Manage speakers…",
        icon: "people" as const,
        onSelect: () => setManagingSpeakersInterview(interview),
      },
      {
        label: "Replace transcript…",
        icon: "refresh" as const,
        onSelect: () => pickVttAndImport(interview.id),
      },
      {
        label: isSingle ? "Delete interview (only one left)" : "Delete interview…",
        icon: "trash" as const,
        destructive: true,
        disabled: isSingle,
        onSelect: async () => {
          const impact = await interviewDeleteImpact(interview.id);
          const parts: string[] = [];
          if (impact.segment_count > 0)
            parts.push(`${impact.segment_count} passages`);
          if (impact.coded_segment_count > 0)
            parts.push(`${impact.coded_segment_count} coded`);
          if (impact.has_hub_memo) parts.push("analytic memo");
          const summary = parts.length > 0 ? ` (${parts.join(", ")})` : "";
          const ok = await appConfirm({
            title: `Delete “${interview.participant_label}”?`,
            body: summary
              ? `This removes ${summary.replace(/^\(|\)$/g, "")} from this study. This cannot be undone.`
              : "This interview will be removed from this study. This cannot be undone.",
            confirmLabel: "Delete interview",
            cancelLabel: "Keep interview",
            destructive: true,
            dedupeKey: `delete-interview-${interview.id}`,
          });
          if (ok) {
            await deleteInterview(interview.id);
            showStatus(`Deleted "${interview.participant_label}".`);
          }
        },
      },
    ];
  }

  const dark = usePrefersDark();
  const ground = dark ? THEME_GROUND.dark : THEME_GROUND.light;
  const isFiltered = codeFilterIds.length > 0 || speakerFilter !== null;

  const reviewedCount = useMemo(
    () => segments.filter((s) => reviewedBySegment[s.id]).length,
    [segments, reviewedBySegment],
  );

  const passageCodings = useCallback(
    (segId: string) => {
      return codedBySegment.get(segId) ?? EMPTY_CODINGS;
    },
    [codedBySegment],
  );

  return (
    <main
      data-testid="transcript-panel"
      className="@container glass-panel flex h-full min-h-0 min-w-0 flex-col overflow-hidden"
    >
      {/* Header bar */}
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-[var(--g-rim)] px-4">
        {interviews.length > 0 ? (
          <>
            {interviews.length > 1 && <InterviewHistoryNav />}
            <select
              value={activeInterviewId ?? ""}
              onChange={(e) => selectInterview(e.target.value)}
              aria-label="Current interview"
              className="field field-sm min-w-0 max-w-[200px] truncate text-[13px] font-medium @2xl:max-w-none"
            >
              {interviews.map((iv) => (
                <option key={iv.id} value={iv.id}>
                  {iv.participant_label}
                  {iv.segment_count === 0 ? " (no transcript)" : ""}
                </option>
              ))}
            </select>

            {activeInterview && (
              <button
                type="button"
                onClick={(e) =>
                  openContextMenu(e, interviewOverflowMenu(activeInterview))
                }
                aria-label={`Interview actions for ${activeInterview.participant_label}`}
                title="Interview actions"
                className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[var(--ink-2)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <Icon name="dots" size={14} />
              </button>
            )}

            {segments.length > 0 && (
              <span className="text-xs text-[var(--ink-3)] shrink-0 ml-1">
                {reviewedCount} of {segments.length} reviewed
              </span>
            )}
          </>
        ) : (
          <span className="hint">No interviews yet</span>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">

          {segments.length > 0 && (
            <span
              className="flex items-center gap-0.5"
              role="group"
              aria-label="Passage text size"
            >
              <button
                type="button"
                onClick={() => void setTranscriptZoom(stepZoom(zoom, -1))}
                disabled={zoom <= ZOOM_MIN}
                aria-label="Decrease passage text size"
                title="Decrease passage text size"
                className="btn btn-ghost btn-sm"
              >
                <Icon name="minus" size={13} />
              </button>
              <button
                type="button"
                onClick={() => void setTranscriptZoom(null)}
                aria-label={`Reset passage text size (currently ${zoomPercent(zoom)} percent)`}
                title="Reset to 100%"
                className="min-w-11 rounded px-1 py-0.5 text-center text-[11px] tabular-nums text-[var(--ink-3)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
              >
                {zoomPercent(zoom)}%
              </button>
              <button
                type="button"
                onClick={() => void setTranscriptZoom(stepZoom(zoom, 1))}
                disabled={zoom >= ZOOM_MAX}
                aria-label="Increase passage text size"
                title="Increase passage text size"
                className="btn btn-ghost btn-sm"
              >
                <Icon name="plus" size={13} />
              </button>
            </span>
          )}

          {/* Filter sits with Search: both act on this transcript, and it
              used to live in the window toolbar a row away from it. */}
          {segments.length > 0 && <FilterButton />}

          {segments.length > 0 && (
            <label className="relative flex items-center">
              <Icon
                name="search"
                size={13}
                className="pointer-events-none absolute left-2.5 opacity-45"
              />
              <input
                ref={searchInputRef}
                type="search"
                value={transcriptSearch}
                onChange={(e) => setTranscriptSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (e.shiftKey) goPrevMatch();
                    else goNextMatch();
                  }
                }}
                placeholder="Search"
                aria-label="Search transcript"
                className="field field-sm w-24 pl-7 @2xl:w-36"
              />
            </label>
          )}
        </div>
      </div>

      {segments.length === 0 ? (
        <EmptyTranscript
          importing={importing}
          onImport={handleImportVtt}
          onScanFolder={() => setShowLinkPanel(true)}
          hasInterview={interviews.length > 0}
          awaitedPassages={
            interviews.find((i) => i.id === activeInterviewId)
              ?.remote_segment_count ?? null
          }
          pendingCoded={pendingCoded}
        />
      ) : (
        <div className="relative flex flex-1 min-h-0 overflow-hidden">
          {/* Main Transcript Scroller */}
          <div
            ref={scrollerRef}
            data-testid="transcript-scroller"
            onScroll={recordScrollPlace}
            style={{ "--reading-scale": String(zoom) } as React.CSSProperties}
            className="scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain px-6 pb-24 pt-1"
            onMouseDown={(e) => {
              if (!(e.target instanceof HTMLElement)) return;
              if (e.target.closest('[role="option"]')) return;
              // Controls in the sticky filter bar (chips, buttons) must not
              // clear the passage selection on their way to handling the
              // click — clearing first is what used to drop the reader back
              // to the top when a filter was removed.
              if (e.target.closest('[data-testid="transcript-filterbar"]')) {
                return;
              }
              clearPassageSelection();
            }}
          >
            <div className="reading-page mx-auto max-w-xl px-2 pb-2">
              {(search || isFiltered) && (
                <div
                  data-testid="transcript-filterbar"
                  className="glass-bar sticky top-0 z-10 -mx-2 flex flex-wrap items-center gap-2 rounded-b-[12px] px-2 py-2"
                >
                  {search && (
                    <span className="hint text-[11.5px]">
                      {totalMatches === 0
                        ? isFiltered
                          ? "No matches in filtered view"
                          : "No matches"
                        : `${currentMatchIndex + 1} of ${totalMatches}${isFiltered ? " in filtered view" : ""}`}
                    </span>
                  )}
                  {isFiltered && (
                    <span className="hint text-[11.5px]">
                      {visibleSegments.length === 0
                        ? "No passages match"
                        : `Showing ${visibleSegments.length} of ${segments.length} passages`}
                    </span>
                  )}
                  {codeFilterIds.map((cid) => {
                    const code = codesById.get(cid);
                    if (!code) return null;
                    return (
                      <button
                        key={cid}
                        type="button"
                        onClick={() => toggleCodeFilter(cid)}
                        className="chip"
                        style={{
                          background: `${code.color}22`,
                          color: readableOn(code.color, ground),
                        }}
                        title={`Remove "${code.name}" filter`}
                      >
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: readableOn(code.color, ground) }}
                        />
                        <span>{code.name}</span>
                        <Icon name="close" size={11} />
                      </button>
                    );
                  })}
                  {codeFilterIds.length >= 2 && (
                    <button
                      type="button"
                      onClick={() =>
                        setFilterMatchMode(
                          filterMatchMode === "any" ? "all" : "any",
                        )
                      }
                      className="chip text-[11.5px] font-medium"
                      title="Toggle match mode between Any and All"
                    >
                      <span>Match: {filterMatchMode === "any" ? "Any" : "All"}</span>
                    </button>
                  )}
                  {speakerFilter && (
                    <button
                      type="button"
                      onClick={() => setSpeakerFilter(null)}
                      className="chip"
                      title="Clear speaker filter"
                    >
                      <Icon name="filter" size={11} />
                      <span>from “{showSpeaker(speakerFilter)}”</span>
                      <Icon name="close" size={11} />
                    </button>
                  )}
                  {isFiltered && (
                    <button
                      type="button"
                      onClick={() => clearAllFilters()}
                      className="text-[11.5px] font-medium text-[var(--accent)] hover:underline ml-auto"
                    >
                      Clear all
                    </button>
                  )}
                </div>
              )}

              {visibleSegments.length === 0 && isFiltered ? (
                <div className="flex flex-col items-center justify-center py-16 text-center">
                  <div
                    className="grid h-12 w-12 place-items-center rounded-[14px] mb-3"
                    style={{ background: "var(--fill)", color: "var(--ink-3)" }}
                  >
                    <Icon name="filter" size={20} />
                  </div>
                  <p className="text-[13px] font-medium text-[var(--ink-2)]">
                    No passages match
                  </p>
                  <p className="text-[12px] text-[var(--ink-3)] mt-0.5">
                    No passages match the current filters.
                  </p>
                  <button
                    type="button"
                    onClick={() => clearAllFilters()}
                    className="btn btn-secondary btn-sm mt-3"
                  >
                    Clear all
                  </button>
                </div>
              ) : (
                <div
                  role="listbox"
                aria-label="Transcript passages"
                aria-activedescendant={
                  selectedSegmentId ? `segment-${selectedSegmentId}` : undefined
                }
                onKeyDown={onListKeyDown}
                className="flex flex-col gap-1 outline-none"
              >
                {visibleSegments.map((seg) => {
                  const isSelected = seg.id === selectedSegmentId;
                  const segCodings = passageCodings(seg.id);
                  const isCoded = segCodings.length > 0;
                  const isReviewed = Boolean(reviewedBySegment[seg.id]);
                  return (
                    <article
                      key={seg.id}
                      ref={(el) => {
                        if (el) articleRefs.current.set(seg.id, el);
                        else articleRefs.current.delete(seg.id);
                      }}
                      id={`segment-${seg.id}`}
                      role="option"
                      aria-label={`Passage ${seg.segment_index + 1}${isReviewed ? " — Reviewed" : ""}${isCoded ? "" : " — Not yet coded"}: ${showSpeaker(seg.speaker)}`}
                      aria-selected={isSelected}
                      tabIndex={isSelected ? 0 : -1}
                      onClick={(e) => {
                        // Shift+click extends the pending span from its stored
                        // anchor instead of re-selecting. Same passage only:
                        // a different passage keeps today's behavior below,
                        // plus the cross-passage notice.
                        if (e.shiftKey) {
                          const anchor = anchorRef.current;
                          if (anchor && anchor.segmentId !== seg.id) {
                            showStatus(
                              "A coded span has to sit inside one speaker turn.",
                              "info",
                            );
                          } else if (anchor) {
                            const article = e.currentTarget;
                            const p = article.querySelector("p");
                            if (p) {
                              const focus = clickOffsetIn(
                                p,
                                e.clientX,
                                e.clientY,
                              );
                              if (focus !== null) {
                                const extended = extendSpan(
                                  seg.text,
                                  anchor.anchor,
                                  focus,
                                );
                                if (extended) {
                                  setPendingSelection({
                                    segmentId: seg.id,
                                    ...extended,
                                  });
                                  const box = p.getBoundingClientRect();
                                  const sel = window.getSelection();
                                  const r =
                                    sel && sel.rangeCount > 0
                                      ? sel.getRangeAt(0).getBoundingClientRect()
                                      : null;
                                  setBubbleAnchor({
                                    segmentId: seg.id,
                                    rel: r
                                      ? {
                                          top: r.top - box.top,
                                          left: r.left - box.left,
                                          bottom: r.bottom - box.top,
                                        }
                                      : null,
                                  });
                                  return;
                                }
                              }
                            }
                            showStatus(
                              "A coded span has to sit inside one speaker turn.",
                              "info",
                            );
                            return;
                          }
                        }
                        // The click that ends a drag-select: the mouseup just
                        // stored the pending span (and the anchor) for this
                        // passage, so there is nothing to do — and clearing
                        // here would wipe the anchor. (The bubble focusing its
                        // input collapses the native selection, so a
                        // collapsed-selection check cannot tell this echo
                        // apart from a genuine plain click; the live pending
                        // span can.)
                        if (pendingSpan && pendingSpan.segmentId === seg.id) {
                          return;
                        }
                        if (window.getSelection()?.isCollapsed !== false) {
                          anchorRef.current = null;
                        }
                        setSelectedSegmentId(seg.id, "click");
                        if (window.getSelection()?.isCollapsed !== false) {
                          const article = e.currentTarget;
                          requestAnimationFrame(() => article.focus({ preventScroll: true }));
                        }
                      }}
                      onFocus={() => {
                        if (selectedSegmentId !== seg.id) {
                          setSelectedSegmentId(seg.id, "click");
                        }
                      }}
                      onContextMenu={(e) => {
                        setSelectedSegmentId(seg.id, "click");
                        openContextMenu(e, segmentMenu(seg));
                      }}
                      className="group rounded-[14px] px-4 py-3 transition-all"
                      style={{
                        background: isSelected ? "var(--fill-on)" : "transparent",
                        boxShadow: isSelected
                          ? "var(--shadow-1), inset 3px 0 0 0 var(--accent), inset 0 0 0 1px var(--accent)"
                          : "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!isSelected)
                          e.currentTarget.style.background = "var(--fill)";
                      }}
                      onMouseLeave={(e) => {
                        if (!isSelected)
                          e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <header className="mb-1.5 flex items-center gap-2 text-[11px]">
                        <span
                          className="shrink-0 font-mono tabular-nums"
                          style={{ color: isReviewed ? "var(--ink-3)" : "var(--ink-4)" }}
                          aria-label={`Passage ${seg.segment_index + 1}`}
                        >
                          {seg.segment_index + 1}
                        </span>
                        <button
                          type="button"
                          ref={speakerPopoverSegment?.id === seg.id ? speakerButtonRef : undefined}
                          onClick={(e) => {
                            e.stopPropagation();
                            openSpeakerPopover(seg, e.currentTarget);
                          }}
                          aria-label={`Change speaker for passage ${seg.segment_index + 1} (currently ${showSpeaker(seg.speaker)})`}
                          title="Change speaker label"
                          className="font-medium rounded px-1 -mx-1 transition-colors hover:bg-[var(--fill)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] text-left"
                          style={{
                            color: isReviewed
                              ? "var(--ink-3)"
                              : seg.speaker === "Interviewer"
                                ? "var(--ink-3)"
                                : "var(--ink)",
                          }}
                        >
                          {showSpeaker(seg.speaker)}
                        </button>
                        <span
                          className="font-mono text-[10.5px] tabular-nums"
                          style={{ color: isReviewed ? "var(--ink-3)" : "var(--ink-4)" }}
                        >
                          {formatTimestampDisplay(seg.timestamp_start)}
                        </span>
                        <div className="ml-auto flex items-center gap-1.5">
                          {isReviewed && (
                            <span
                              data-testid="reviewed-badge"
                              title="Reviewed"
                              className="inline-flex items-center text-[var(--ok)]"
                            >
                              <Icon name="check" size={12} />
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void setSegmentReviewed(seg.id, !isReviewed);
                            }}
                            aria-label={isReviewed ? "Mark not reviewed" : "Mark reviewed"}
                            title={isReviewed ? "Mark not reviewed" : "Mark reviewed"}
                            className="opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-[var(--ink-3)] transition-opacity hover:bg-[var(--fill)] hover:text-[var(--ink)]"
                          >
                            {isReviewed ? "Mark not reviewed" : "Mark reviewed"}
                          </button>
                        </div>
                      </header>

                      <PassageText
                        segmentId={seg.id}
                        segmentIndex={seg.segment_index}
                        text={seg.text}
                        coded={segCodings}
                        activeCoder={activeCoder}
                        codeFilter={codeFilter}
                        setCodeFilter={setCodeFilter}
                        openNoteFor={openNoteForCoding}
                        removeCodeFromCoding={removeCodeFromCoding}
                        clearMemoForCoding={clearMemoForCoding}
                        codesById={codesById}
                        pending={
                          pendingSpan && pendingSpan.segmentId === seg.id
                            ? { start: pendingSpan.start, end: pendingSpan.end }
                            : null
                        }
                        matches={matchesBySegment.get(seg.id) ?? EMPTY_MATCHES}
                        currentMatch={
                          activeMatch && activeMatch.segmentId === seg.id
                            ? activeMatch
                            : null
                        }
                        onSelectCoding={selectCoding}
                        hoveredPillCodeId={hoveredPillCodeId}
                        flashCodeId={flashCodeId}
                        zoom={zoom}
                        isReviewed={isReviewed}
                      />

                      {/* Code chips: one per code per coder. A code on two
                          spans of this passage is one chip with a count, and
                          clicking it steps through the spans. */}
                      {segCodings.length > 0 && (
                        <div className="mt-2.5 flex min-w-0 flex-col gap-1.5 pl-8 pt-1">
                          {groupPassageChips(segCodings, activeCoder, codesById).map((group) => (
                            // Another coder's chips get their own line, the
                            // name in front, so a wrapped chip stays under
                            // that name instead of reading as yours.
                            <div key={group.coder} className="flex min-w-0 items-start gap-2">
                              {group.theirs && (
                                <span
                                  className="shrink-0 whitespace-nowrap pt-[3px] text-[11px]"
                                  style={{ color: "var(--ink-3)" }}
                                >
                                  {group.coder}
                                </span>
                              )}
                              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                              {group.chips.map(({ code, codings }) => {
                                const chipKey = `${seg.id}|${group.coder}|${code.id}`;
                                const openNext = () => {
                                  const last = lastChipCodingRef.current;
                                  const next = nextCoding(
                                    codings,
                                    last?.chipKey === chipKey ? last.codingId : null,
                                  );
                                  lastChipCodingRef.current = { chipKey, codingId: next.id };
                                  selectCoding(next, code.id);
                                };
                                const where =
                                  codings.length > 1
                                    ? `on ${codings.length} spans of passage ${seg.segment_index + 1}; click to step through them`
                                    : `on passage ${seg.segment_index + 1}`;
                                return (
                                  <button
                                    key={code.id}
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (e.altKey) {
                                        setCodeFilters([code.id]);
                                      } else {
                                        openNext();
                                      }
                                    }}
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      e.stopPropagation();
                                      openContextMenu(e, [
                                        {
                                          label: `Show only passages coded “${code.name}”`,
                                          icon: "filter",
                                          onSelect: () => setCodeFilters([code.id]),
                                        },
                                        {
                                          label: "Edit coding",
                                          icon: "edit",
                                          onSelect: openNext,
                                        },
                                      ]);
                                    }}
                                    onPointerEnter={() => setHoveredPillCodeId(code.id)}
                                    onPointerLeave={() => setHoveredPillCodeId(null)}
                                    title={`${group.theirs ? `${group.coder} coded this. ` : ""}“${code.name}” ${where}. Right-click to filter by this code.`}
                                    className="code-chip"
                                    data-active={hoveredPillCodeId === code.id || undefined}
                                    style={{ "--code": code.color } as React.CSSProperties}
                                  >
                                    <span className="code-chip-name">{code.name}</span>
                                    {codings.length > 1 && (
                                      <span className="code-chip-count" aria-label={`${codings.length} spans`}>
                                        ×{codings.length}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
            )}
            </div>
          </div>
        </div>
      )}

      <SelectionBubble
        anchor={bubbleAnchor}
        onDismiss={() => {
          setBubbleAnchor(null);
          setPendingSelection(null);
        }}
      />

      <NewInterviewModal
        open={showNewInterview}
        knownLabels={interviews.map((i) => i.participant_label)}
        onCancel={() => setShowNewInterview(false)}
        onConfirm={handleNewInterviewConfirm}
      />

      <BulkImportModal
        open={showBulkImport}
        onClose={() => setShowBulkImport(false)}
      />

      {editingInterview && (
        <InterviewSettingsModal
          interview={editingInterview}
          onClose={() => setEditingInterview(null)}
          onRename={renameInterview}
          onDelete={deleteInterview}
          loadImpact={interviewDeleteImpact}
          redactionOn={
            editingInterview.id === activeInterviewId ? redactionOn : false
          }
          redactionPreview={
            editingInterview.id === activeInterviewId
              ? aliasPreview(
                  [...segments]
                    .sort((a, b) => a.segment_index - b.segment_index)
                    .map((seg) => seg.speaker),
                )
              : []
          }
          onToggleRedaction={(on) =>
            setSpeakerRedaction(editingInterview.id, on)
          }
        />
      )}

      {managingSpeakersInterview && (
        <ManageSpeakersModal
          open={true}
          interview={managingSpeakersInterview}
          onClose={() => setManagingSpeakersInterview(null)}
        />
      )}

      {showLinkPanel && (
        <TranscriptLinkPanel
          open={showLinkPanel}
          onClose={() => setShowLinkPanel(false)}
        />
      )}

      {speakerPopoverSegment && speakerPopoverRect && (
        <SpeakerPickerPopover
          segment={speakerPopoverSegment}
          allSegments={segments}
          anchorRect={speakerPopoverRect}
          showSpeaker={showSpeaker}
          onApply={async (segmentId, newSpeaker, includeFollowing) => {
            await setSegmentSpeaker(segmentId, newSpeaker, includeFollowing);
          }}
          onClose={closeSpeakerPopover}
        />
      )}
    </main>
  );
}

/**
 * PassageText with multi-code underlines (B2), mark context menu (A2), and
 * the single inline note editor: every Add/Edit route selects the shared
 * coding identity and the editor docks below its source passage.
 */
/**
 * Background layers for a mark: an optional full-height tint (search match)
 * under the 2 px underline pinned to the bottom of the inline box. See
 * underlineLayer() for why the line is a background, not text-decoration.
 */
function markBackground(
  mark: InlineMark | null,
  otherCoder: boolean,
  tint?: string,
): React.CSSProperties {
  const underline = underlineLayer(mark, otherCoder);
  const layers: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  if (underline) {
    layers.push(underline);
    sizes.push(`100% ${MARK_THICKNESS_PX}px`);
    positions.push("0 100%");
  }
  if (tint) {
    layers.push(`linear-gradient(${tint}, ${tint})`);
    sizes.push("100% 100%");
    positions.push("0 0");
  }
  if (layers.length === 0) return {};
  return {
    backgroundImage: layers.join(", "),
    backgroundSize: sizes.join(", "),
    backgroundPosition: positions.join(", "),
    backgroundRepeat: "no-repeat",
  };
}

const PassageText = memo(function PassageText({
  segmentId,
  segmentIndex,
  text,
  coded,
  activeCoder,
  codeFilter,
  setCodeFilter,
  openNoteFor,
  removeCodeFromCoding,
  clearMemoForCoding,
  codesById,
  pending,
  matches,
  currentMatch,
  onSelectCoding,
  hoveredPillCodeId,
  flashCodeId,
  zoom,
  isReviewed,
}: {
  segmentId: string;
  segmentIndex: number;
  text: string;
  coded: CodedSegment[];
  activeCoder: string;
  codeFilter: string | null;
  setCodeFilter: (codeId: string | null) => void;
  openNoteFor: (codedSegmentId: string) => void;
  removeCodeFromCoding: (codingId: string, codeId: string) => Promise<void>;
  clearMemoForCoding: (codingId: string) => Promise<void>;
  codesById: Map<string, Code>;
  pending: { start: number; end: number } | null;
  matches: MatchRange[];
  currentMatch: MatchRange | null;
  onSelectCoding?: (coding: CodedSegment, codeId?: string) => void;
  hoveredPillCodeId?: string | null;
  flashCodeId?: string | null;
  zoom?: number;
  isReviewed?: boolean;
}) {
  const runs = useMemo(
    () => highlightRuns(text, coded, codesById),
    [text, coded, codesById],
  );
  // Codings with a saved note, plus codings holding only an unfinished draft:
  // the toggle must survive the collapse so the draft can be reopened.
  // Subscribed as one stable string so keystrokes in the open editor do not
  // re-render every passage on the screen.
  const draftCodingIds = useNoteDraftStore((s) =>
    Object.values(s.entries)
      .filter((e) => e.kind === "coding")
      .map((e) => e.targetId)
      .sort()
      .join(","),
  );
  const draftIdSet = useMemo(() => new Set(draftCodingIds ? draftCodingIds.split(",") : []), [draftCodingIds]);
  const notes = useMemo(
    () => coded.filter((coding) => coding.memo?.trim() || draftIdSet.has(coding.id)),
    [coded, draftIdSet],
  );
  const activeInlineCodingId = useNoteDraftStore((s) => s.activeInlineCodingId);
  const closeNote = useProjectStore((s) => s.closeNote);
  const noteKey = notes
    .map(
      (coding) =>
        `${coding.id}:${coding.memo}:${coding.char_start}:${coding.char_end}:${draftIdSet.has(coding.id) ? "draft" : ""}`,
    )
    .join("|");
  const textRootRef = useRef<HTMLDivElement>(null);
  const [noteTops, setNoteTops] = useState<Record<string, number>>({});
  const [hoveredStripeCodeId, setHoveredStripeCodeId] = useState<string | null>(null);
  const [stripeLayout, setStripeLayout] = useState<StripeLayoutResult | null>(null);
  const [paragraphHeight, setParagraphHeight] = useState<number>(0);

  const pendingRun =
    pending && pending.end > pending.start
      ? { start: pending.start, end: pending.end }
      : null;
  const dark = usePrefersDark();

  useLayoutEffect(() => {
    const root = textRootRef.current;
    const paragraph = root?.querySelector<HTMLElement>("[data-passage-copy]");
    if (!root || !paragraph) return;

    setParagraphHeight(paragraph.offsetHeight);

    const base = paragraph.getBoundingClientRect().top;
    // Toggles carry their coding id, so draft-only toggles interleaved with
    // saved-note toggles cannot misalign an index-based mapping.
    const noteButtons = root.querySelectorAll<HTMLElement>("button[data-note-toggle]");
    const tops: Record<string, number> = {};
    noteButtons.forEach((btn) => {
      const id = btn.dataset.noteToggle;
      if (!id) return;
      const r = btn.getBoundingClientRect();
      tops[id] = Math.max(0, r.top - base);
    });
    setNoteTops(tops);

    const anchors = Array.from(
      paragraph.querySelectorAll<HTMLElement>("[data-run-start]"),
    );

    const layout = computeStripeLayout({
      coded,
      codesById,
      activeCoder,
      codeFilter,
      passageHeight: paragraph.offsetHeight,
      measureSpans: (coding) => {
        const start = coding.char_start ?? 0;
        const end = coding.char_end ?? 0;
        const matchingAnchors = anchors.filter((el) => {
          const rs = Number(el.dataset.runStart);
          const re = Number(el.dataset.runEnd);
          return rs < end && re > start;
        });
        if (matchingAnchors.length === 0) return [];
        return matchingAnchors.map((el) => {
          const r = el.getBoundingClientRect();
          return {
            top: Math.max(0, r.top - base),
            height: r.height,
          };
        });
      },
    });
    setStripeLayout(layout);
  }, [text, coded, noteKey, codesById, activeCoder, codeFilter, zoom]);

  const pieces = useMemo(() => {
    return splitRunsOnMatches(runs, text, {
      pending: pendingRun,
      matches,
      currentMatch,
    });
  }, [runs, text, pendingRun, matches, currentMatch]);

  return (
    <div ref={textRootRef} className="relative">
      {/* Left stripe gutter */}
      {stripeLayout && (
        <div
          data-testid="stripe-gutter"
          className="absolute left-0 top-0 w-7 select-none pointer-events-auto z-10"
          style={{
            height: paragraphHeight || undefined,
            opacity: isReviewed ? 0.55 : undefined,
          }}
          aria-hidden="true"
        >
          {stripeLayout.stripes.map((s, idx) => {
            const isHovered = (hoveredPillCodeId ?? hoveredStripeCodeId) === s.codeId;
            return (
              <div
                key={`${s.codeId}-${idx}`}
                data-testid="stripe-bar"
                data-code-id={s.codeId}
                title={`${s.codeName}${s.isDashed ? " (other coder)" : ""}`}
                onPointerEnter={() => setHoveredStripeCodeId(s.codeId)}
                onPointerLeave={() => setHoveredStripeCodeId(null)}
                className="absolute cursor-pointer transition-opacity"
                style={{
                  left: s.columnIndex * 5,
                  top: s.top,
                  height: s.height,
                  width: 3,
                  // Another coder's coding is the same bar at reduced
                  // strength, as its underline is. A dashed 3 px border
                  // drew a short bar as a bracket.
                  borderLeft: `3px solid ${s.color}`,
                  opacity:
                    (hoveredPillCodeId ?? hoveredStripeCodeId) && !isHovered
                      ? 0.35
                      : s.isDashed
                        ? 0.55
                        : 1,
                  borderRadius: 1,
                }}
              />
            );
          })}
          {stripeLayout.overflowCount > 0 && (
            <div
              className="absolute top-0 right-0 rounded bg-[var(--fill)] px-0.5 font-sans text-[9px] font-medium text-[var(--ink-3)] cursor-help"
              title={stripeLayout.overflowCodes.map((c) => c.name).join(", ")}
            >
              +{stripeLayout.overflowCount}
            </div>
          )}
        </div>
      )}

      <p
        data-passage-copy
        className="pl-8 pr-7 font-serif leading-[1.62]"
        style={{
          fontSize: "calc(15.5px * var(--reading-scale, 1))",
          color: isReviewed ? "var(--ink-3)" : undefined,
        }}
      >
        {pieces.map((run) => {
          const hasOtherCoder =
            Boolean(activeCoder && run.coders.some((c) => c !== activeCoder)) ||
            run.unresolvedCount > 0;

          if (run.codes.length === 0) {
            if (run.unresolvedCount > 0) {
              return (
                <span
                  key={run.start}
                  data-run-start={run.start}
                  data-run-end={run.end}
                >
                  <mark
                    title={formatRunAttribution(run, activeCoder)}
                    className="cursor-help"
                    style={{
                      color: "inherit",
                      backgroundColor: "transparent",
                      ...markBackground(inlineMark(run), false),
                    }}
                  >
                    {run.text}
                  </mark>
                </span>
              );
            }
            return (
              <span
                key={run.start}
                data-run-start={run.start}
                data-run-end={run.end}
              >
                <span
                  data-is-match={run.isMatch ? "true" : undefined}
                  data-current-match={run.isCurrentMatch ? "true" : undefined}
                  style={
                    run.pending
                      ? {
                          background: "var(--accent-soft)",
                          boxShadow: "inset 0 -2px 0 0 var(--accent)",
                          borderRadius: 3,
                        }
                      : run.isMatch
                        ? {
                            boxShadow: "0 0 0 1.5px var(--find-ring)",
                            background: run.isCurrentMatch
                              ? "var(--find-on)"
                              : undefined,
                            borderRadius: 2,
                          }
                        : undefined
                  }
                >
                  {run.text}
                </span>
              </span>
            );
          }

          const activeHoverId =
            flashCodeId ?? hoveredPillCodeId ?? hoveredStripeCodeId;
          const hasActiveHover = activeHoverId !== null;
          const isStripeOrPillHighlighted =
            hasActiveHover && run.codes.some((c) => c.id === activeHoverId);
          // A parent filter tints its sub-codes' text too.
          const matchesFilter = (c: Code) => c.id === codeFilter || c.parent_id === codeFilter;
          const isFilterHighlighted = Boolean(codeFilter) && run.codes.some(matchesFilter);
          const isFlashed = Boolean(
            flashCodeId && run.codes.some((c) => c.id === flashCodeId),
          );

          // No fill at rest: the underline is the mark. A tint appears only
          // while a code is being pointed at (pill, side bar, flash) or
          // filtered, so the matching text stands out on demand.
          let bg = "transparent";
          if (isStripeOrPillHighlighted) {
            const matchedCode = run.codes.find((c) => c.id === activeHoverId);
            if (matchedCode) {
              bg = `${matchedCode.color}${dark ? "40" : "2e"}`;
            }
          } else if (isFilterHighlighted) {
            const matchedCode = run.codes.find(matchesFilter);
            if (matchedCode) {
              bg = `${matchedCode.color}${dark ? "40" : "2e"}`;
            }
          }

          const mark = inlineMark(run);

          const matchedCodeForFlash = isFlashed
            ? run.codes.find((c) => c.id === flashCodeId)
            : null;

          return (
            <span
              key={run.start}
              data-run-start={run.start}
              data-run-end={run.end}
            >
              <mark
                data-coding-id={run.codes.map((c) => c.id).join(",")}
                data-is-match={run.isMatch ? "true" : undefined}
                data-current-match={run.isCurrentMatch ? "true" : undefined}
                title={formatRunAttribution(run, activeCoder)}
                onClick={(e) => {
                  if (e.shiftKey) return;
                  const sel = window.getSelection();
                  if (sel && !sel.isCollapsed) return;
                  e.stopPropagation();

                  const p = textRootRef.current?.querySelector<HTMLElement>(
                    "[data-passage-copy]",
                  );
                  const clickOffset = p
                    ? clickOffsetIn(p, e.clientX, e.clientY)
                    : run.start;
                  const targetCoding =
                    resolveClickedCoding(coded, clickOffset ?? run.start) ??
                    coded.find((c) =>
                      run.codes.some((rc) => c.code_ids.includes(rc.id)),
                    ) ??
                    null;
                  if (targetCoding) {
                    onSelectCoding?.(targetCoding, run.codes[0]?.id);
                  }
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  const items = buildMarkMenuItems({
                    segmentId,
                    run: {
                      start: run.start,
                      end: run.end,
                      wholeTurnOnly: run.wholeTurnOnly,
                    },
                    codedSegments: coded,
                    codesById,
                    activeCoder,
                    codeFilter,
                    setCodeFilter,
                    openNoteFor,
                    removeCodeFromCoding,
                    clearMemoForCoding,
                  });
                  openContextMenu(e, items);
                }}
                className="cursor-pointer"
                style={{
                  color: "inherit",
                  backgroundColor: bg,
                  boxShadow: run.isMatch ? "0 0 0 1.5px var(--find-ring)" : undefined,
                  outline: isFlashed
                    ? `2px solid ${matchedCodeForFlash?.color ?? "var(--accent)"}`
                    : undefined,
                  outlineOffset: isFlashed ? "1px" : undefined,
                  ...markBackground(
                    mark,
                    hasOtherCoder,
                    run.isCurrentMatch ? "var(--find-on)" : undefined,
                  ),
                }}
              >
                {run.text}
              </mark>
            </span>
          );
        })}
      </p>

      {/* Inline passage notes column. One shared editor identity: the toggle
          collapses (retaining the draft) and reopens the same draft. A saved
          note keeps its icon; a draft-only note gets a distinguishable dot. */}
      {notes.map((coding) => {
        const top = noteTops[coding.id] ?? 0;
        const isActive = activeInlineCodingId === coding.id;
        const hasDraft = draftIdSet.has(coding.id);
        const hasSaved = Boolean(coding.memo?.trim());
        return (
          <div
            key={coding.id}
            className="absolute right-0 w-6 flex justify-center"
            style={{ top }}
          >
            <button
              type="button"
              data-note-toggle={coding.id}
              onClick={(e) => {
                e.stopPropagation();
                if (isActive) closeNote();
                else {
                  openNoteFor(coding.id);
                  // Focus lands in the editor on mount (autoFocus); closing
                  // returns focus here via data-note-toggle.
                }
              }}
              aria-expanded={isActive}
              aria-label={
                isActive
                  ? "Collapse note"
                  : hasSaved
                    ? "Expand note"
                    : "Expand unsaved note draft"
              }
              className="relative grid h-6 w-6 place-items-center rounded-full text-[var(--accent)] hover:bg-[var(--fill)]"
              title={
                hasSaved ? (coding.memo ?? "Passage note") : "Unsaved note draft"
              }
            >
              <Icon name="note" size={13} />
              {!hasSaved && hasDraft ? (
                <span
                  aria-hidden="true"
                  className="absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
                />
              ) : null}
            </button>
          </div>
        );
      })}

      {/* The one inline editor, docked below the passage text (before code
          pills and the next passage), never overlaying prose. Hidden by
          ordinary filtering along with its passage — the draft is retained
          in the store and the editor restores when the passage returns. */}
      {activeInlineCodingId &&
        (() => {
          const activeCoding = coded.find((c) => c.id === activeInlineCodingId);
          if (!activeCoding) return null;
          return (
            <div className="pl-8 pr-7 pt-2">
              <InlineNoteEditor
                coding={activeCoding}
                passageText={text}
                segmentIndex={segmentIndex}
                codesById={codesById}
              />
            </div>
          );
        })()}
    </div>
  );
});

/**
 * The one inline passage-note editor, docked below its source passage.
 *
 * Every Add/Edit route (note toggle, coding menu, selection bubble) selects
 * the shared coding identity and lands here. It autosaves through revision
 * CAS after a typing pause (useAutosaveMemo), and Done flushes and closes;
 * Collapse, Escape, switching passage or interview and filtering retain the
 * draft without prompting, and reopening restores it. Discard appears only
 * for text a save rejected, and confirms.
 */
function InlineNoteEditor({
  coding,
  passageText,
  segmentIndex,
  codesById,
}: {
  coding: CodedSegment;
  passageText: string;
  segmentIndex: number;
  codesById: Map<string, Code>;
}) {
  const workspace = useNoteDraftStore((s) => s.workspace);
  const activeCoder = useProjectStore((s) => s.activeCoder);
  const closeNote = useProjectStore((s) => s.closeNote);
  const frozen = useNoteDraftStore((s) => s.frozen);
  const entryKey =
    workspace != null ? `${workspace.projectKey}::coding::${coding.id}` : null;
  const entry = useNoteDraftStore((s) => (entryKey ? s.entries[entryKey] : undefined));
  const [beginError, setBeginError] = useState<string | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const quote =
    coding.char_start != null && coding.char_end != null
      ? passageText.slice(coding.char_start, coding.char_end)
      : passageText;
  const codeItems = coding.code_ids
    .map((id) => codesById.get(id))
    .filter((code): code is Code => !!code);

  // Begin (or resume) the draft when the editor mounts for a target. A repeat
  // call for the same identity focuses the existing draft without reseeding.
  useEffect(() => {
    if (!workspace) return;
    setBeginError(null);
    setConfirmingDiscard(false);
    void useNoteDraftStore
      .getState()
      .beginDraft({
        kind: "coding",
        targetId: coding.id,
        interviewId: coding.interview_id,
        coderName: activeCoder || coding.coder_name,
        participantLabel: coding.participant_label,
        segmentId: coding.segment_id,
        segmentIndex,
        charStart: coding.char_start,
        charEnd: coding.char_end,
        quoteText: quote,
      })
      .catch((error: unknown) => {
        setBeginError(error instanceof Error ? error.message : String(error));
      });
    // The identity IS the subscription: a new coding id re-begins, the same
    // id refocuses. Committed text arrives through the store, not props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coding.id, workspace?.projectKey, workspace?.epoch]);

  // `autoFocus` alone never worked for a note whose draft was not already
  // begun: the textarea mounts disabled until beginDraft resolves, and a
  // disabled element ignores autoFocus — the first keystrokes went to the
  // transcript as passage shortcuts. Focus once, when it first becomes usable.
  const editable = entry != null;
  const focusedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!editable || focusedFor.current === coding.id) return;
    focusedFor.current = coding.id;
    const el = textareaRef.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [editable, coding.id]);

  // Passage notes autosave after a typing pause, like the interview note.
  // Closing the card flushes; a conflict or a deleted coding stops it.
  const autosave = useAutosaveMemo(
    entryKey,
    entry != null && !frozen && entry.saveState !== "conflict" && !entry.targetMissing,
  );

  if (!workspace) return null;

  const dirty = entry != null && entry.draftText !== entry.baseText;
  const conflicted = entry?.saveState === "conflict" && entry.conflictText !== null;
  const missing =
    entry?.targetMissing ||
    (beginError !== null && /no longer available/i.test(beginError));
  const saveFailed = entry?.saveState === "error" && !entry.targetMissing;
  const recoveryFailed =
    entry != null && (entry.recoveryState === "error" || entry.recoveryState === "unavailable");

  const focusToggle = () => {
    document
      .querySelector<HTMLElement>(`button[data-note-toggle="${coding.id}"]`)
      ?.focus();
  };

  const collapse = () => {
    // Collapse retains the draft: no prompt, no discard. Reopening restores it.
    setConfirmingDiscard(false);
    closeNote();
    focusToggle();
  };

  // Done saves whatever the pause timer has not reached yet, then closes —
  // only if that exact revision is now committed. A failed save keeps the
  // editor open on its error.
  const done = () => {
    if (!entryKey || saving) return;
    setSaving(true);
    void (async () => {
      const store = useNoteDraftStore.getState();
      await store.flushPending();
      const pending = store.getEntryByKey(entryKey);
      const ok = pending && isDraftDirty(pending) ? await store.saveDraft(entryKey) : true;
      setSaving(false);
      const live = useNoteDraftStore.getState().entries[entryKey];
      if (ok && (!live || live.draftText === live.baseText)) {
        closeNote();
        focusToggle();
      } else {
        textareaRef.current?.focus();
      }
    })().catch(() => setSaving(false));
  };

  const discard = () => {
    if (!entryKey) return;
    void useNoteDraftStore
      .getState()
      .discardDraft(entryKey)
      .then((ok) => {
        if (ok) {
          setConfirmingDiscard(false);
          closeNote();
          focusToggle();
        }
      });
  };

  return (
    <div
      className="note-card relative w-full p-3 shadow-xl z-10"
      onClick={(event) => event.stopPropagation()}
    >
      <div className="flex items-start justify-between gap-3 pb-2">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium leading-tight">Passage {segmentIndex + 1}</div>
          {codeItems.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {codeItems.map((code) => (
                <span
                  key={code.id}
                  className="code-chip"
                  style={{ "--code": code.color } as React.CSSProperties}
                >
                  <span className="code-chip-name">{code.name}</span>
                </span>
              ))}
            </div>
          )}
          {quote ? (
            <span className="line-clamp-2 block pt-1 font-serif italic text-[12px] text-[var(--ink-3)]">
              “{quote}”
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {!conflicted && !saveFailed && !missing ? (
            <span className="hint text-[11px]" role="status">
              {dirty || saving || autosave.status === "saving"
                ? "Saving…"
                : autosave.status === "saved"
                  ? "Saved"
                  : null}
            </span>
          ) : null}
          <button
            type="button"
            onClick={collapse}
            aria-label="Close note editor"
            className="grid h-6 w-6 place-items-center rounded-md text-[var(--ink-3)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          >
            <Icon name="close" size={12} />
          </button>
        </div>
      </div>

      {beginError && !missing ? (
        <div
          role="alert"
          className="mb-2 rounded-md bg-[var(--danger,#b03a34)]/10 px-2.5 py-1.5 text-[11.5px] text-[var(--danger,#b03a34)]"
        >
          {beginError}
        </div>
      ) : null}
      {missing ? (
        <div
          role="alert"
          className="mb-2 rounded-md bg-[var(--danger,#b03a34)]/10 px-2.5 py-1.5 text-[11.5px] text-[var(--danger,#b03a34)]"
        >
          The original coding is no longer available. Your unsaved text is kept in
          Unsaved notes — copy it before discarding.
        </div>
      ) : null}

      <textarea
        ref={textareaRef}
        value={entry?.draftText ?? ""}
        onChange={(e) => {
          if (entryKey && !frozen) useNoteDraftStore.getState().editDraft(entryKey, e.target.value);
        }}
        onKeyDown={(e) => {
          const mod = e.metaKey || e.ctrlKey;
          if (mod && e.key === "Enter") {
            e.preventDefault();
            if (!frozen) done();
            return;
          }
          if (e.key === "Escape" && !e.nativeEvent.isComposing) {
            // Escape collapses and retains — it never discards.
            e.preventDefault();
            e.stopPropagation();
            collapse();
          }
        }}
        autoFocus
        placeholder="Why does this passage get this coding? Record your reasoning…"
        aria-label="Note content"
        disabled={entry == null || conflicted || frozen}
        className="field w-full resize-none text-[13px] leading-relaxed p-2.5 min-h-[120px]"
      />

      {conflicted && entryKey ? (
        <div className="mt-2 flex items-center gap-2 rounded-lg bg-[var(--fill)] p-2">
          <span className="flex-1 text-[11.5px]">
            This note changed elsewhere. Compare before saving — the comparison is
            the editable surface meanwhile.
          </span>
          <NoteConflictModal entryKey={entryKey} triggerLabel="Compare" />
        </div>
      ) : null}

      {saveFailed && entry ? (
        <div
          role="alert"
          className="mt-2 rounded-md bg-[var(--danger,#b03a34)]/10 px-2.5 py-1.5 text-[11.5px] text-[var(--danger,#b03a34)]"
        >
          <span>Could not save note: {entry.saveError}</span>{" "}
          <button
            type="button"
            className="link font-medium"
            onClick={() => {
              if (entryKey) void useNoteDraftStore.getState().saveDraft(entryKey);
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {recoveryFailed && entry ? (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--ink-3)]">
          <span role="alert">Draft not backed up — Retry</span>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => useNoteDraftStore.getState().retryRecovery(entry.key)}
          >
            Retry
          </button>
        </div>
      ) : null}

      <div className="mt-2.5 pt-2 border-t border-[var(--g-rim)]/60">
        {confirmingDiscard ? (
          <div className="flex flex-col gap-2 rounded-lg bg-[var(--fill)] p-2">
            <span className="text-[11.5px] font-medium text-[var(--danger,#b03a34)]">
              Discard changes to this note?
            </span>
            <div className="flex items-center gap-1.5 justify-end">
              <button
                type="button"
                onClick={() => {
                  setConfirmingDiscard(false);
                  textareaRef.current?.focus();
                }}
                className="btn btn-ghost btn-xs"
              >
                Keep editing
              </button>
              <button type="button" onClick={discard} className="btn btn-danger btn-xs">
                Discard
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <span className="hint text-[10.5px]">
              Saves as you type · Esc to close
            </span>
            <div className="flex items-center gap-1.5">
              {/* Autosave leaves nothing to discard, except text a save rejected. */}
              {saveFailed && dirty ? (
                <button
                  type="button"
                  onClick={() => setConfirmingDiscard(true)}
                  disabled={saving}
                  className="btn btn-ghost btn-sm text-[var(--danger,#b03a34)] hover:bg-[var(--danger,#b03a34)]/10"
                >
                  Discard
                </button>
              ) : null}
              <button
                type="button"
                onClick={done}
                disabled={saving || frozen}
                title={`Done (${modKey}↵)`}
                className="btn btn-primary btn-sm"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyTranscript({
  importing,
  onImport,
  onScanFolder,
  hasInterview,
  awaitedPassages,
  pendingCoded,
}: {
  importing: boolean;
  onImport: () => void;
  onScanFolder?: () => void;
  hasInterview: boolean;
  awaitedPassages: number | null;
  pendingCoded: number;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
      <div
        className="grid h-14 w-14 place-items-center rounded-[18px]"
        style={{ background: "var(--fill)", color: "var(--ink-3)" }}
      >
        <Icon name="note" size={24} />
      </div>
      <p className="mt-4 text-[15px] font-medium">
        {awaitedPassages
          ? "Your coder has this transcript"
          : hasInterview
            ? "This participant has no transcript linked on this computer"
            : "No transcript yet"}
      </p>
      <p className="hint mt-1.5 max-w-xs">
        {awaitedPassages ? (
          <>
            They have <strong>{awaitedPassages}</strong> passages here. Import
            the same file from your shared folder and your coding will line up
            with theirs automatically.
          </>
        ) : (
          <>
            Zoom captions, SRT, a Word document, or plain text with speaker
            labels. Fleuron splits it into speaker turns you can code one at a
            time.
          </>
        )}
      </p>
      {pendingCoded > 0 && (
        <p
          className="mt-3 rounded-[11px] px-3 py-2 text-[12.5px]"
          style={{ background: "var(--ok-soft)", color: "var(--ok)" }}
        >
          <strong>{pendingCoded}</strong> coded passage
          {pendingCoded === 1 ? "" : "s"} from your colleague{" "}
          {pendingCoded === 1 ? "is" : "are"} already on this computer. Importing
          the transcript attaches {pendingCoded === 1 ? "it" : "them"}
          automatically.
        </p>
      )}

      <div className="mt-5 flex items-center gap-2">
        <button
          type="button"
          onClick={onImport}
          disabled={importing}
          className="btn btn-primary"
        >
          <Icon name="import" size={15} />
          {importing ? "Importing…" : "Import transcript"}
        </button>
        {onScanFolder && (
          <button
            type="button"
            onClick={onScanFolder}
            disabled={importing}
            className="btn btn-secondary gap-1.5"
          >
            <Icon name="folder" size={14} />
            Scan folder…
          </button>
        )}
      </div>
    </div>
  );
}
