import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ActivityLogEntry } from "../lib/types";
import { useProjectStore } from "../store/project-store";
import { SideSheet } from "./ui/Surfaces";

/**
 * The backend records short action ids (`create_project`, `reset_workspace`).
 * Older studies can hold ids no current build writes, so anything unknown is
 * turned into words rather than shown raw.
 */
const ACTION_LABELS: Record<string, string> = {
  create_project: "Study created",
  codebook: "Codebook change",
  interview: "Interview deleted",
  reset_workspace: "Coding reset",
  export: "Export",
  import_segments: "Transcript imported",
};

export function activityLabel(action: string): string {
  const known = ACTION_LABELS[action];
  if (known) return known;
  const words = action.replace(/_/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : "Activity";
}

const WHEN = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function ActivityLogPanel() {
  const { showActivityLog, setShowActivityLog, loadActivity } = useProjectStore(
    useShallow((s) => ({
      showActivityLog: s.showActivityLog,
      setShowActivityLog: s.setShowActivityLog,
      loadActivity: s.loadActivity,
    })),
  );
  const [entries, setEntries] = useState<ActivityLogEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!showActivityLog) return;
    setLoading(true);
    loadActivity()
      .then(setEntries)
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [showActivityLog, loadActivity]);

  return (
    <SideSheet
      open={showActivityLog}
      onClose={() => setShowActivityLog(false)}
      title="Activity log"
      subtitle="Exports, deletions and resets in this study"
    >
      <div className="scroll flex-1 p-4">
        {loading ? (
          <p className="hint">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="hint">Nothing recorded yet.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {entries.map((entry) => (
              <li
                key={entry.id}
                className="rounded-[12px] p-2.5 text-[12px]"
                style={{ background: "var(--fill)" }}
              >
                <p className="font-medium">
                  {activityLabel(entry.action)}
                  <span className="font-normal" style={{ color: "var(--ink-3)" }}>
                    {" · "}
                    {entry.coder_name === "system" ? "Fleuron" : entry.coder_name}
                  </span>
                </p>
                <p style={{ color: "var(--ink-3)" }}>
                  {WHEN.format(new Date(entry.created_at))}
                </p>
                {entry.detail && (
                  <p className="mt-1" style={{ color: "var(--ink-2)" }}>
                    {entry.detail}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SideSheet>
  );
}
