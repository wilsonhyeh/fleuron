import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Icon } from "./ui/Icon";
import { fileManagerName, shortcut } from "../lib/platform";
import { friendlyLocation } from "../lib/format";

/**
 * "Where is my work?" — answered from the toolbar's save status.
 *
 * Saving is continuous, so the one question left is where it goes: nothing
 * in the workspace named the study folder, and a researcher looking for it
 * had to remember where they created it. The panel names the folder, opens it
 * in the file manager, and says the one thing that can lose work: the folder
 * is a live database while Fleuron has it open.
 */
export function StudyLocationPopover({
  path,
  onClose,
}: {
  path: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const parts = friendlyLocation(path);
  const folder = parts[parts.length - 1] ?? path;
  const parents = parts.slice(0, -1);

  useEffect(() => {
    const onPointer = (e: PointerEvent) => {
      const root = ref.current;
      // The trigger toggles on its own; a press on it must not close-then-reopen.
      if (root && !root.contains(e.target as Node) && !root.parentElement?.contains(e.target as Node)) {
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Where your work is saved"
      data-tauri-drag-region="false"
      className="note-card absolute right-0 top-full z-50 mt-2 w-[340px] p-3.5 text-left shadow-xl"
    >
      <p className="text-[13px] font-semibold text-[var(--ink)]">Where your work is saved</p>

      <div className="mt-2.5 flex items-start gap-2 rounded-[10px] bg-[var(--fill)] px-2.5 py-2">
        <Icon name="folder" size={15} className="mt-0.5 shrink-0 text-[var(--ink-3)]" />
        <div className="min-w-0">
          <p className="break-all text-[12.5px] font-medium leading-snug text-[var(--ink)]">{folder}</p>
          {parents.length > 0 && (
            <p className="mt-0.5 break-all text-[11.5px] leading-snug text-[var(--ink-3)]">
              in {parents.join(" › ")}
            </p>
          )}
        </div>
      </div>

      <p className="mt-2.5 text-[12px] leading-relaxed text-[var(--ink-2)]">
        This study folder holds all of it: transcripts, codes, coding and notes. Coding is written
        here the moment you make it and notes after a short pause. {shortcut("mod", "S")} writes
        everything right away.
      </p>

      <div className="mt-3 flex items-center gap-1.5">
        <button
          type="button"
          className="btn btn-outline btn-sm"
          onClick={() => {
            void revealItemInDir(path).catch(() => undefined);
          }}
        >
          <Icon name="folder" size={13} />
          Show in {fileManagerName}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(path)
              .then(() => setCopied(true))
              .catch(() => undefined);
          }}
        >
          {copied ? "Copied" : "Copy path"}
        </button>
      </div>

      <p className="hint mt-3 border-t border-[var(--g-rim)]/60 pt-2.5 text-[11px] leading-relaxed">
        Automatic backups are kept inside it, in <span className="font-medium">backups</span>. To copy
        or move the folder, close the study first — while it is open, the newest work may not be in
        the copy yet.
      </p>
    </div>
  );
}
