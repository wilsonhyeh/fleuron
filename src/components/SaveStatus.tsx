import { useEffect } from "react";
import { Icon } from "./ui/Icon";
import { hasModKey, isMac, shortcut } from "../lib/platform";
import { useProjectStore } from "../store/project-store";
import { useSaveIndicator, useSaveStore } from "../store/save-store";

/**
 * Toolbar save indicator, and the webview half of ⌘S.
 *
 * Quiet when everything is saved — a muted check, no chip — because that is
 * the state the app is in almost all the time. It only becomes a button when
 * there is something to do: unsaved notes (click saves them) or a note that
 * could not be saved (click opens Unfinished notes to compare or retry).
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

  if (indicator.kind === "saved") {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1 px-1 text-[11.5px] text-[var(--ink-3)]"
        title="Everything is saved to the study file. Coding saves as you go."
      >
        <Icon name="check" size={12} />
        Saved
      </span>
    );
  }

  if (indicator.kind === "saving") {
    return (
      <span role="status" className="inline-flex items-center gap-1 px-1 text-[11.5px] text-[var(--ink-3)]">
        <Icon name="clock" size={12} />
        Saving…
      </span>
    );
  }

  if (indicator.kind === "unsaved") {
    const noun = indicator.count === 1 ? "note" : "notes";
    return (
      <button
        type="button"
        className="chip chip-accent"
        onClick={() => void saveAll()}
        title={`${indicator.count} ${noun} not saved to the study yet. Drafts are backed up on this computer. Click or press ${key} to save.`}
      >
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />
        {indicator.count} unsaved {noun}
      </button>
    );
  }

  return (
    <button
      type="button"
      role="alert"
      className="chip chip-warn"
      onClick={() => setShowRecoveryPanel(true)}
      title={`${indicator.message} Click to review.`}
    >
      <Icon name="alert" size={12} />
      Not saved
    </button>
  );
}
