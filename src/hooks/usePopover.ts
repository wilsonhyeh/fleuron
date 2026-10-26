import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Open state for a small anchored popover: closes on a pointer-down outside
 * `rootRef` and hands focus back to `triggerRef` when it closes.
 */
export function usePopover<T extends HTMLElement = HTMLButtonElement>() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<T>(null);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    // pointerdown, not click: dragging into a backdrop shouldn't fire a click
    // on whatever was underneath.
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return { open, setOpen, close, rootRef, triggerRef };
}
