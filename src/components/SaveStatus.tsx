import { useCallback, useEffect, useState } from "react";
import { Icon } from "./ui/Icon";
import { hasModKey, isMac, shortcut } from "../lib/platform";
import { useProjectStore } from "../store/project-store";
import { useNoteDraftStore } from "../store/note-draft-store";
import { useSaveIndicator, useSaveStore } from "../store/save-store";
import { StudyLocationPopover } from "./StudyLocationPopover";

/**
 * Toolbar save indicator, and the webview half of ⌘S.
 *
 * Quiet when everything is saved — a muted check, no chip — because that is
 * the state the app is in almost all the time. Clicking it says where the
 * work is saved (StudyLocationPopover). It only becomes a button when
 * there is something to do: unsaved notes (click saves them, or opens Unsaved
 * notes when they are drafts left from an earlier session) or a note that
 * could not be saved (click opens Unsaved notes to compare or retry).
 *
 * ⌘S is bound twice on purpose: the native File > Save accelerator, and a
 * keydown listener here, because a focused webview can swallow the menu
 * accelerator (Windows) and the browser design harness has no menu at all.
 * `saveAll` coalesces, so both firing saves once.
 */
export function SaveStatus() {
  const indicator = useSaveIndicator();
  const saveAll = useSaveStore((s) => s.saveAll);
  const setShowRecoveryPanel = useProjectStore((s) => s.setShowRecoveryPanel);
  const projectPath = useProjectStore((s) => s.project?.path);
  const [showLocation, setShowLocation] = useState(false);
  const closeLocation = useCallback(() => setShowLocation(false), []);
  const showRecoveryPanel = useProjectStore((s) => s.showRecoveryPanel);
  const refreshRecovered = useSaveStore((s) => s.refreshRecovered);
  const epoch = useNoteDraftStore((s) => s.workspace?.epoch);
  const entryCount = useNoteDraftStore((s) => Object.keys(s.entries).length);

  // Recovered drafts live outside the draft store until resumed; recount on
  // opening a study, after the panel closes, and as drafts are loaded.
  useEffect(() => {
    if (!showRecoveryPanel) void refreshRecovered();
  }, [refreshRecovered, epoch, showRecoveryPanel, entryCount]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!hasModKey(e) || e.shiftKey || e.altKey) return;
      // On macOS Ctrl+S is not Save; on Windows Meta+S is the OS's.
      if (isMac ? !e.metaKey : !e.ctrlKey) return;
      if (e.key.toLowerCase() !== "s") return;
      e.preventDefault();
      void saveAll();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveAll]);

  const key = shortcut("mod", "S");

  if (indicator.kind === "saved" || indicator.kind === "saving") {
    const saved = indicator.kind === "saved";
    return (
      <span className="relative inline-flex" data-tauri-drag-region="false">
        <button
          type="button"
          onClick={() => setShowLocation((open) => !open)}
          aria-expanded={showLocation}
          aria-haspopup="dialog"
          aria-label={saved ? "Saved" : "Saving…"}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] text-[var(--ink-3)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          title={saved ? "Everything is saved. Click to see where." : "Saving. Click to see where."}
        >
          <Icon name={saved ? "check" : "clock"} size={12} />
          <span role="status">{saved ? "Saved" : "Saving…"}</span>
        </button>
        {showLocation && projectPath ? (
          <StudyLocationPopover path={projectPath} onClose={closeLocation} />
        ) : null}
      </span>
    );
  }

  if (indicator.kind === "unsaved") {
    const noun = indicator.count === 1 ? "note" : "notes";
    const onlyRecovered = indicator.recovered === indicator.count;
    return (
      <button
        type="button"
        className="chip chip-accent"
        onClick={() => (onlyRecovered ? setShowRecoveryPanel(true) : void saveAll())}
        title={
          onlyRecovered
            ? `${indicator.count} ${noun} from an earlier session ${indicator.count === 1 ? "is" : "are"} not in the study yet. Click to review.`
            : `${indicator.count} ${noun} not saved to the study yet. Drafts are backed up on this computer. Click or press ${key} to save.`
        }
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
        {indicator.count} unsaved {noun}
      </button>
    );
  }

  return (
    // Not role="alert": the editor holding the failed note already announces
    // it, and a second live region would read every failure out twice.
    <button
      type="button"
      className="chip chip-warn"
      onClick={() => setShowRecoveryPanel(true)}
      title={`${indicator.message} Click to review.`}
    >
      <Icon name="alert" size={12} />
      Not saved
    </button>
  );
}
