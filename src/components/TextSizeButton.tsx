import { usePopover } from "../hooks/usePopover";
import { shortcut } from "../lib/platform";
import { Icon } from "./ui/Icon";

/**
 * Passage text size, behind one "Aa" button. The − 100% + stepper used to sit
 * in the header permanently for something set once and then left alone; the
 * shortcuts (⌘− ⌘+ ⌘0) still work without opening it.
 */
export function TextSizeButton({
  percent,
  canShrink,
  canGrow,
  onShrink,
  onGrow,
  onReset,
}: {
  percent: number;
  canShrink: boolean;
  canGrow: boolean;
  onShrink: () => void;
  onGrow: () => void;
  onReset: () => void;
}) {
  const { open, setOpen, close, rootRef, triggerRef } = usePopover();

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Text size"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Text size"
        onClick={() => setOpen((v) => !v)}
        className={`header-icon-btn font-serif text-[13px] ${percent !== 100 ? "text-[var(--accent)]" : ""}`}
      >
        Aa
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Passage text size"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
          className="glass-pop anim-rise absolute right-0 top-[calc(100%+6px)] z-50 flex items-center gap-1 p-1.5"
        >
          <button
            type="button"
            onClick={onShrink}
            disabled={!canShrink}
            aria-label="Decrease passage text size"
            title={`Smaller text (${shortcut("mod", "-")})`}
            className="header-icon-btn disabled:opacity-35"
          >
            <Icon name="minus" size={13} />
          </button>
          <button
            type="button"
            onClick={onReset}
            aria-label={`Reset passage text size (currently ${percent} percent)`}
            title={`Reset to 100% (${shortcut("mod", "0")})`}
            className="h-7 min-w-12 rounded-lg px-1 text-center text-[12px] tabular-nums text-[var(--ink-2)] transition-colors hover:bg-[var(--fill)] hover:text-[var(--ink)]"
          >
            {percent}%
          </button>
          <button
            type="button"
            onClick={onGrow}
            disabled={!canGrow}
            aria-label="Increase passage text size"
            title={`Larger text (${shortcut("mod", "+")})`}
            className="header-icon-btn disabled:opacity-35"
          >
            <Icon name="plus" size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
