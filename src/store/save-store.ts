import { create } from "zustand";
import { api } from "../lib/api";
import { isDraftDirty, useNoteDraftStore, type NoteDraftEntry } from "./note-draft-store";

/**
 * File > Save (⌘S / Ctrl+S) and the toolbar save indicator.
 *
 * Coding, codebook and transcript edits are written to project.db as they
 * happen, so the only work that can be unsaved is a note draft. Both note
 * editors autosave after a typing pause; Save commits every
 * committable draft in the open study, serially through the same CAS save the
 * editors use, then folds the WAL into project.db so a copy of the folder
 * taken afterwards is complete.
 *
 * Never a prompt: a conflict or failed save is left on its entry, where the
 * editor already shows Compare / Retry, and the indicator says how many are
 * stuck. Drafts whose target is gone are not committable and stay in
 * Unsaved notes.
 */

export type SaveRunStatus = "idle" | "saving" | "saved" | "error";

export interface SaveOutcome {
  saved: number;
  conflicts: number;
  failed: number;
  error: string | null;
}

interface SaveStore {
  status: SaveRunStatus;
  error: string | null;
  /** Coalesces ⌘S arriving from both the native menu and the webview. */
  inFlight: Promise<SaveOutcome> | null;
  saveAll: () => Promise<SaveOutcome>;
  /** Entry keys with an open, autosaving editor (mount counts). */
  autosaving: Record<string, number>;
  watchAutosave: (key: string) => () => void;
  /**
   * Draft ids in local recovery for the open study that no editor has loaded
   * yet: words left from a forced quit. Not committable from here — they
   * need Resume in Unsaved notes — but they are unsaved work all the same.
   */
  recovered: { projectKey: string; draftIds: string[] } | null;
  refreshRecovered: () => Promise<void>;
}

export function committableDirty(
  entries: Record<string, NoteDraftEntry>,
  projectKey: string | undefined,
): NoteDraftEntry[] {
  if (!projectKey) return [];
  return Object.values(entries).filter(
    (entry) => entry.projectKey === projectKey && isDraftDirty(entry) && !entry.targetMissing,
  );
}

export const useSaveStore = create<SaveStore>()((set, get) => ({
  status: "idle",
  error: null,
  inFlight: null,
  autosaving: {},
  recovered: null,

  watchAutosave: (key) => {
    set((s) => ({ autosaving: { ...s.autosaving, [key]: (s.autosaving[key] ?? 0) + 1 } }));
    return () =>
      set((s) => {
        const next = { ...s.autosaving };
        if ((next[key] ?? 0) <= 1) delete next[key];
        else next[key] -= 1;
        return { autosaving: next };
      });
  },

  refreshRecovered: async () => {
    const projectKey = useNoteDraftStore.getState().workspace?.projectKey;
    if (!projectKey) {
      set({ recovered: null });
      return;
    }
    try {
      const records = await api.listNoteDrafts();
      const draftIds = records
        .filter((r) => r.project_key === projectKey && !r.discarded && r.draft_text !== r.base_text)
        .map((r) => r.draft_id);
      // A study switch while listing would attribute these to the wrong one.
      if (useNoteDraftStore.getState().workspace?.projectKey !== projectKey) return;
      set({ recovered: { projectKey, draftIds } });
    } catch {
      // Recovery unavailable: the editors already say so; count nothing.
      set({ recovered: { projectKey, draftIds: [] } });
    }
  },

  saveAll: () => {
    const running = get().inFlight;
    if (running) return running;

    const run = (async (): Promise<SaveOutcome> => {
      set({ status: "saving", error: null });
      const drafts = useNoteDraftStore.getState();
      const outcome: SaveOutcome = { saved: 0, conflicts: 0, failed: 0, error: null };
      try {
        await drafts.flushPending();
        const projectKey = useNoteDraftStore.getState().workspace?.projectKey;
        const keys = committableDirty(useNoteDraftStore.getState().entries, projectKey).map(
          (entry) => entry.key,
        );
        for (const key of keys) {
          const entry = useNoteDraftStore.getState().entries[key];
          if (!entry || !isDraftDirty(entry)) continue;
          const ok = await drafts.saveDraft(key);
          const live = useNoteDraftStore.getState().entries[key];
          if (ok) outcome.saved += 1;
          else if (live?.saveState === "conflict") outcome.conflicts += 1;
          else if (live?.targetMissing) continue;
          else {
            outcome.failed += 1;
            outcome.error ??= live?.saveError ?? "Could not save a note.";
          }
        }
        await api.saveOpenProject();
        await get().refreshRecovered();
      } catch (error) {
        outcome.failed += 1;
        outcome.error = error instanceof Error ? error.message : String(error);
      }

      const stuck = outcome.conflicts + outcome.failed;
      set({
        status: stuck > 0 ? "error" : "saved",
        error:
          stuck === 0
            ? null
            : outcome.conflicts > 0 && outcome.failed === 0
              ? `${outcome.conflicts === 1 ? "A note" : `${outcome.conflicts} notes`} changed elsewhere. Open ${outcome.conflicts === 1 ? "it" : "them"} to compare.`
              : outcome.error,
        inFlight: null,
      });
      return outcome;
    })();

    set({ inFlight: run });
    return run;
  },
}));

/**
 * What the toolbar shows. Derived live from the draft entries, so a draft
 * whose editor closed before it saved reads as unsaved at once, and one with
 * an autosave timer behind it reads as saving.
 */
export type SaveIndicator =
  | { kind: "saved" }
  | { kind: "saving" }
  /** `recovered` of `count` are from an earlier session and need Resume. */
  | { kind: "unsaved"; count: number; recovered: number }
  | { kind: "error"; message: string; count: number };

export function deriveSaveIndicator(input: {
  entries: Record<string, NoteDraftEntry>;
  projectKey: string | undefined;
  run: SaveRunStatus;
  runError: string | null;
  autosaving: Record<string, number>;
  recovered: SaveStore["recovered"];
}): SaveIndicator {
  const { entries, projectKey, run, runError, autosaving, recovered } = input;
  const scoped = projectKey
    ? Object.values(entries).filter((entry) => entry.projectKey === projectKey)
    : [];
  const dirty = committableDirty(entries, projectKey);
  const stuck = dirty.filter(
    (entry) => entry.saveState === "conflict" || entry.saveState === "error",
  );
  const waiting = dirty.filter((entry) => !stuck.includes(entry));
  // An open editor autosaves after a typing pause, and a save in flight is
  // already happening: neither is unsaved work, and counting them would
  // flash the chip on every pause.
  const unwatched = waiting.filter((entry) => !autosaving[entry.key] && !entry.saveInFlight);
  const loaded = new Set(scoped.map((entry) => entry.draftId));
  const fromRecovery =
    recovered && recovered.projectKey === projectKey
      ? recovered.draftIds.filter((id) => !loaded.has(id)).length
      : 0;

  if (run === "saving") return { kind: "saving" };
  if (stuck.length > 0) {
    const conflict = stuck.some((entry) => entry.saveState === "conflict");
    return {
      kind: "error",
      count: stuck.length,
      message:
        runError ??
        (conflict
          ? "A note changed elsewhere. Open it to compare."
          : (stuck[0].saveError ?? "A note could not be saved.")),
    };
  }
  if (unwatched.length > 0 || fromRecovery > 0) {
    return { kind: "unsaved", count: unwatched.length + fromRecovery, recovered: fromRecovery };
  }
  if (waiting.length > 0 || scoped.some((entry) => entry.saveInFlight)) return { kind: "saving" };
  return { kind: "saved" };
}

export function useSaveIndicator(): SaveIndicator {
  const projectKey = useNoteDraftStore((s) => s.workspace?.projectKey);
  const entries = useNoteDraftStore((s) => s.entries);
  const run = useSaveStore((s) => s.status);
  const runError = useSaveStore((s) => s.error);
  const autosaving = useSaveStore((s) => s.autosaving);
  const recovered = useSaveStore((s) => s.recovered);
  return deriveSaveIndicator({ entries, projectKey, run, runError, autosaving, recovered });
}
