import { create } from "zustand";
import { api } from "../lib/api";
import { isDraftDirty, useNoteDraftStore, type NoteDraftEntry } from "./note-draft-store";

/**
 * File > Save (⌘S / Ctrl+S) and the toolbar save indicator.
 *
 * Coding, codebook and transcript edits are written to project.db as they
 * happen, so the only work that can be unsaved is a note draft: passage notes
 * commit on ⌘↩, the interview note after a typing pause. Save commits every
 * committable draft in the open study, serially through the same CAS save the
 * editors use, then folds the WAL into project.db so a copy of the folder
 * taken afterwards is complete.
 *
 * Never a prompt: a conflict or failed save is left on its entry, where the
 * editor already shows Compare / Retry, and the indicator says how many are
 * stuck. Drafts whose target is gone are not committable and stay in
 * Unfinished notes.
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
 * What the toolbar shows. Derived live from the draft entries so typing flips
 * it to unsaved immediately, and a background autosave flips it back.
 */
export type SaveIndicator =
  | { kind: "saved" }
  | { kind: "saving" }
  | { kind: "unsaved"; count: number }
  | { kind: "error"; message: string; count: number };

export function useSaveIndicator(): SaveIndicator {
  const projectKey = useNoteDraftStore((s) => s.workspace?.projectKey);
  const entries = useNoteDraftStore((s) => s.entries);
  const run = useSaveStore((s) => s.status);
  const runError = useSaveStore((s) => s.error);

  const scoped = projectKey
    ? Object.values(entries).filter((entry) => entry.projectKey === projectKey)
    : [];
  const dirty = committableDirty(entries, projectKey);
  const stuck = dirty.filter(
    (entry) => entry.saveState === "conflict" || entry.saveState === "error",
  );
  // The interview note autosaves after a typing pause, so a dirty one is a
  // save about to happen, not unsaved work — counting it would flash the
  // chip on every pause. Passage notes wait for ⌘↩ or ⌘S.
  const waiting = dirty.filter((entry) => !stuck.includes(entry));
  const manual = waiting.filter((entry) => entry.kind !== "interview");
  const autosaving = waiting.length > manual.length;

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
  if (manual.length > 0) return { kind: "unsaved", count: manual.length };
  if (autosaving || scoped.some((entry) => entry.saveInFlight)) return { kind: "saving" };
  return { kind: "saved" };
}
