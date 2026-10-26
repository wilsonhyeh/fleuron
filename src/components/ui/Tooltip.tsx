import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  delay?: number;
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
  disabled?: boolean;
}

export function Tooltip({
  content,
  children,
  delay = 350,
  side = "top",
  className = "",
  disabled = false,
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  /** Set by a click on the trigger, so the focus that follows it does not
      bring the tip straight back. Cleared when the pointer leaves. */
  const pressedRef = useRef(false);

  const calculatePos = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const gap = 6;

    let top = 0;
    let left = 0;

    switch (side) {
      case "top":
        top = rect.top - gap;
        left = rect.left + rect.width / 2;
        break;
      case "bottom":
        top = rect.bottom + gap;
        left = rect.left + rect.width / 2;
        break;
      case "left":
        top = rect.top + rect.height / 2;
        left = rect.left - gap;
        break;
      case "right":
        top = rect.top + rect.height / 2;
        left = rect.right + gap;
        break;
    }

    setPos({ top, left });
  }, [side]);

  const show = () => {
    if (disabled || !content) return;
    timerRef.current = window.setTimeout(() => {
      calculatePos();
      setOpen(true);
    }, delay);
  };

  const hide = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setOpen(false);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const transformStyle =
    side === "top"
      ? "translate(-50%, -100%)"
      : side === "bottom"
        ? "translate(-50%, 0%)"
        : side === "left"
          ? "translate(-100%, -50%)"
          : "translate(0%, -50%)";

  return (
    <>
      <span
        ref={triggerRef}
        onMouseEnter={show}
        onMouseLeave={() => {
          pressedRef.current = false;
          hide();
        }}
        // A click starts whatever the control does (often a dialog over the
        // trigger), and the pointer never "leaves", so the tip stayed on top.
        onPointerDown={() => {
          pressedRef.current = true;
          hide();
        }}
        onFocus={() => {
          if (!pressedRef.current) show();
        }}
        onBlur={hide}
        className={`inline-flex ${className}`}
      >
        {children}
      </span>
      {open &&
        pos &&
        createPortal(
          <div
            role="tooltip"
            className="glass-card pointer-events-none fixed z-[90] px-2 py-1 text-[11px] font-medium leading-tight shadow-md select-none rounded-md"
            style={{
              top: pos.top,
              left: pos.left,
              transform: transformStyle,
              color: "var(--ink-2)",
              borderColor: "var(--g-rim)",
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
