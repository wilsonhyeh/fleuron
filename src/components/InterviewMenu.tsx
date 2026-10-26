import { Fragment, useEffect, useRef } from "react";
import type { Interview } from "../lib/types";
import { usePopover } from "../hooks/usePopover";
import { Icon } from "./ui/Icon";
import { MenuRow, useMenuKeys, type MenuItemSpec } from "./ui/Menu";

/**
 * The interview's name at the left of the reading header, and the one menu
 * for everything about it: which interview (when there are several), how far
 * review has got, and its actions.
 *
 * It replaced three controls: a native `<select>` (which WKWebView opens as a
 * blue macOS popup, and which offered a single choice when there was one
 * interview), a separate "···" for the actions, and a "90 of 288 reviewed"
 * label that left an odd gap beside a short name and collided with the tools
 * when the map pane narrowed the transcript.
 */
export function InterviewMenu({
  interviews,
  activeId,
  onSelect,
  actions,
  reviewed,
  total,
}: {
  interviews: Interview[];
  activeId: string | null;
  onSelect: (id: string) => void;
  actions: MenuItemSpec[];
  reviewed: number;
  total: number;
}) {
  const { open, setOpen, close, rootRef, triggerRef } = usePopover();
  const popRef = useRef<HTMLDivElement>(null);
  const onMenuKeys = useMenuKeys(popRef, close);
  const active = interviews.find((iv) => iv.id === activeId) ?? interviews[0];

  // Open on the current interview, not the top of a long list.
  useEffect(() => {
    if (!open) return;
    const pop = popRef.current;
    const current = pop?.querySelector<HTMLButtonElement>('[aria-current="true"]');
    (current ?? pop?.querySelector<HTMLButtonElement>('[role="menuitem"]'))?.focus();
  }, [open]);

  if (!active) return null;

  const primary = actions.filter((a) => !a.destructive);
  const destructive = actions.filter((a) => a.destructive);

  return (
    <div ref={rootRef} className="relative flex min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Current interview"
        aria-haspopup="menu"
        aria-expanded={open}
        title={active.participant_label}
        onClick={() => setOpen((v) => !v)}
        className="-ml-2 flex h-7 min-w-0 max-w-[280px] items-center gap-1 rounded-lg px-2 text-[13.5px] font-semibold text-[var(--ink)] transition-colors hover:bg-[var(--fill)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] aria-expanded:bg-[var(--fill)]"
      >
        <span className="truncate">{active.participant_label}</span>
        <Icon name="chevronDown" size={12} className="text-[var(--ink-3)]" />
      </button>

      {open && (
        <div
          ref={popRef}
          role="menu"
          aria-label={`Interview ${active.participant_label}`}
          onKeyDown={onMenuKeys}
          className="glass-pop anim-rise absolute left-0 top-[calc(100%+6px)] z-50 w-max min-w-60 max-w-[340px] p-1.5"
        >
          {total > 0 && (
            <div className="px-2.5 pb-2 pt-1.5">
              <div className="text-[11.5px] tabular-nums text-[var(--ink-3)]">
                {reviewed} of {total} passages reviewed
              </div>
              <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-[var(--fill)]">
                <div
                  className="h-full rounded-full bg-[var(--accent)]"
                  style={{ width: `${(reviewed / total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {interviews.length > 1 && (
            <>
              {total > 0 && <div className="divider my-1" role="separator" />}
              <div className="max-h-[40vh] overflow-y-auto">
                {interviews.map((iv) => {
                  const current = iv.id === active.id;
                  return (
                    <button
                      key={iv.id}
                      type="button"
                      role="menuitem"
                      aria-current={current}
                      onClick={() => {
                        close();
                        if (!current) onSelect(iv.id);
                      }}
                      className="flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-1.5 text-left text-[13px] text-[var(--ink)] transition-colors hover:bg-[var(--fill)] focus:bg-[var(--fill)] focus:outline-none"
                    >
                      <Icon
                        name="check"
                        size={15}
                        className={current ? "text-[var(--accent)]" : "invisible"}
                      />
                      <span className={`min-w-0 flex-1 truncate ${current ? "font-medium" : ""}`}>
                        {iv.participant_label}
                      </span>
                      {iv.segment_count === 0 && (
                        <span className="ml-2 shrink-0 text-[11.5px] text-[var(--ink-4)]">
                          no transcript
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          {(total > 0 || interviews.length > 1) && primary.length > 0 && (
            <div className="divider my-1" role="separator" />
          )}
          {primary.map((item, index) => (
            <Fragment key={item.label}>
              {index > 0 && item.section !== primary[index - 1].section ? (
                <div className="divider my-1" role="separator" />
              ) : null}
              <MenuRow item={item} onDone={close} />
            </Fragment>
          ))}
          {destructive.length > 0 && (
            <>
              <div className="divider my-1" role="separator" />
              {destructive.map((item) => (
                <MenuRow key={item.label} item={item} onDone={close} />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
