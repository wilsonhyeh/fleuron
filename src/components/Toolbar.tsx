import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { listen } from "@tauri-apps/api/event";
import { useProjectStore } from "../store/project-store";
import { useGuideStore } from "../store/guide-store";
import { useAppStore } from "../store/app-store";
import { Menu } from "./ui/Menu";
import { SyncChip } from "./SyncChip";
import { COLLABORATION_ENABLED } from "../lib/features";
import { SaveStatus } from "./SaveStatus";
import { UpdateAction, describeUpdateAction } from "./UpdateAction";
import { useSyncStore } from "../store/sync-store";
import { useUpdateStore } from "../store/update-store";
import { useUnfinishedNotesCount } from "./NoteRecoveryPanel";
import type { PresenceUser } from "../lib/types";

export interface BreadcrumbParams {
  studyTitle: string;
  activeInterview: { participant_label: string; segment_count: number } | null | undefined;
  activeCoder: string;
  isShared: boolean;
  myRosterName?: string;
}

export interface BreadcrumbSegments {
  study: string;
  participant: {
    label: string;
    isLinked: boolean;
  };
  coder: {
    name: string;
    isShared: boolean;
  };
}

export function breadcrumbSegments({
  studyTitle,
  activeInterview,
  activeCoder,
  isShared,
  myRosterName,
}: BreadcrumbParams): BreadcrumbSegments {
  const participantLabel = activeInterview
    ? activeInterview.participant_label
    : "No participant";
  const isLinked = activeInterview ? activeInterview.segment_count > 0 : true;
  const coderName = isShared
    ? myRosterName || activeCoder || "You"
    : activeCoder || "You";

  return {
    study: studyTitle,
    participant: {
      label: participantLabel,
      isLinked,
    },
    coder: {
      name: coderName,
      isShared,
    },
  };
}

/**
 * Workspace chrome. Two visible actions plus an overflow menu.
 *
 * Displays orientation breadcrumb: Study › Participant › coding as You
 */
export function Toolbar() {
  const {
    project,
    activeCoder,
    setActiveCoder,
    interviews,
    activeInterviewId,
    requestExportProject,
    requestCloseProject,
    requestResetWorkspace,
    exporting,
    setShowActivityLog,
    setShowProjectFiles,
    setShowBackups,
    setShowInterviewMemo,
    setShowRecoveryPanel,
    goBackInterview,
    goForwardInterview,
  } = useProjectStore(
    useShallow((s) => ({
      project: s.project,
      activeCoder: s.activeCoder,
      setActiveCoder: s.setActiveCoder,
      interviews: s.interviews,
      activeInterviewId: s.activeInterviewId,
      requestExportProject: s.requestExportProject,
      requestCloseProject: s.requestCloseProject,
      requestResetWorkspace: s.requestResetWorkspace,
      exporting: s.exporting,
      setShowActivityLog: s.setShowActivityLog,
      setShowProjectFiles: s.setShowProjectFiles,
      setShowBackups: s.setShowBackups,
      setShowInterviewMemo: s.setShowInterviewMemo,
      setShowRecoveryPanel: s.setShowRecoveryPanel,
      goBackInterview: s.goBackInterview,
      goForwardInterview: s.goForwardInterview,
    })),
  );
  const openGuide = useGuideStore((s) => s.openGuide);
  const updateStatus = useUpdateStore((s) => s.status);
  const openSettings = useAppStore((s) => s.openSettings);
  const setIntent = useAppStore((s) => s.setIntent);
  const openSyncSheet = useSyncStore((s) => s.openSyncSheet);
  const inGroup = useSyncStore((s) => s.status?.inGroup ?? false);
  const group = useSyncStore((s) => s.group);

  const [presenceUsers, setPresenceUsers] = useState<PresenceUser[]>([]);
  const unfinishedCount = useUnfinishedNotesCount();

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod || e.shiftKey || e.altKey) return;
      const target = e.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }

      if (e.key === "[") {
        e.preventDefault();
        void goBackInterview();
      } else if (e.key === "]") {
        e.preventDefault();
        void goForwardInterview();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goBackInterview, goForwardInterview]);

  useEffect(() => {
    if (!inGroup) {
      setPresenceUsers([]);
      return;
    }
    const unsub = listen<PresenceUser[]>("sync://presence-change", (e) => {
      setPresenceUsers(e.payload || []);
    });
    return () => {
      void unsub.then((fn) => fn());
    };
  }, [inGroup]);

  if (!project) return null;

  const me = group?.members.find((m) => m.isYou);
  const groupedName = inGroup ? me?.coderName || activeCoder : activeCoder;
  const lockIdentity = inGroup;
  const coders = project.coders.length > 0 ? project.coders : [groupedName];

  const activeInterview = interviews.find((i) => i.id === activeInterviewId);
  const segments = breadcrumbSegments({
    studyTitle: project.title,
    activeInterview,
    activeCoder,
    isShared: inGroup,
    myRosterName: me?.coderName,
  });

  return (
    // `relative z-30` is load-bearing: .glass-bar's backdrop-filter opens a
    // stacking context, so without an explicit z-index the overflow menu
    // renders correctly but paints *under* the panels below it.
    //
    // `data-tauri-drag-region="deep"` is the only thing that moves this window:
    // the titlebar is hidden, and the `-webkit-app-region` CSS this used to
    // carry is an Electron feature that WKWebView ignores. "deep" makes the
    // whole subtree draggable so the title text works as a handle; the button
    // cluster opts back out below. Harmless on Windows, where the native
    // titlebar is the drag handle and this is simply never used.
    //
    // The left gutter is `.traffic-pad`, not a literal `pl-[78px]`: the space
    // is for macOS traffic lights and must collapse everywhere else.
    <header
      data-tauri-drag-region="deep"
      className="glass-bar traffic-pad relative z-30 flex h-[52px] shrink-0 items-center gap-3 pr-3"
    >
      <div className="min-w-0 flex-1 flex items-center gap-1.5 text-[13px]">
        <span
          className="min-w-0 max-w-[200px] truncate font-semibold leading-tight text-[var(--ink)]"
          title={segments.study}
        >
          {segments.study}
        </span>
        {/* The participant and Back/Forward used to sit here too, repeating
            the reading header's interview selector one row down. They live
            beside that selector now; the toolbar says whose study and who
            is coding. */}
        <span className="text-[var(--ink-4)] shrink-0 select-none">·</span>

        {/* Coder segment - attribution control */}
        <div
          data-tauri-drag-region="false"
          className="shrink-0 flex items-center gap-1 text-[12px] text-[var(--ink-3)]"
        >
          <span>coding as</span>
          {lockIdentity || coders.length <= 1 ? (
            <span className="font-medium text-[var(--ink)]">
              {segments.coder.name}
            </span>
          ) : (
            <select
              className="field field-sm w-auto py-0.5 px-1 font-medium text-[var(--ink)] bg-transparent border-none shadow-none cursor-pointer"
              value={activeCoder}
              onChange={(e) => setActiveCoder(e.target.value)}
              aria-label="Active coder"
              title="Codes you apply are stamped with this name"
            >
              {!activeCoder && (
                <option value="" disabled>
                  Who&apos;s coding?
                </option>
              )}
              {coders.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Live presence chips for other teammates in this study */}
        {presenceUsers.length > 0 && (
          <div
            data-tauri-drag-region="false"
            className="flex items-center gap-1 pl-1.5 border-l border-border/40 shrink-0"
          >
            {presenceUsers.map((u) => {
              const ageMs = Date.now() - new Date(u.updatedAt).getTime();
              const active = !Number.isNaN(ageMs) && ageMs < 60000;
              const tooltip = u.participantLabel && active
                ? `${u.coderName} — coding ${u.participantLabel}`
                : `${u.coderName} — idle`;
              return (
                <span
                  key={u.coderName}
                  title={tooltip}
                  className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-bold select-none cursor-default transition-opacity ${
                    active
                      ? "bg-[var(--accent)] text-white shadow-xs"
                      : "bg-surface-sunken text-muted opacity-50"
                  }`}
                >
                  {u.coderName.trim().charAt(0).toUpperCase() || "?"}
                </span>
              );
            })}
          </div>
        )}
      </div>

      <div
        data-tauri-drag-region="false"
        className="flex shrink-0 items-center gap-2"
      >
        <SaveStatus />
        {COLLABORATION_ENABLED && <SyncChip />}
        <UpdateAction compact hideWhenIdle />

        <button
          type="button"
          onClick={() => requestExportProject()}
          disabled={exporting}
          className="btn btn-primary"
          title="Configure and export reports, coded extracts, and matrix"
        >
          {exporting ? "Exporting…" : "Export…"}
        </button>

        <Menu
          label="More actions"
          items={[
            // Grouped by what each acts on, dividers between groups. About
            // left this menu: the app menu and Help menu both carry it.
            {
              label: "New interview…",
              icon: "plus",
              section: "interview",
              onSelect: () => setIntent("new-interview"),
            },
            {
              label: "Replace transcript…",
              icon: "import",
              section: "interview",
              onSelect: () => setIntent("import-vtt"),
            },
            {
              label: "Notes on this interview…",
              icon: "note",
              section: "interview",
              onSelect: () => setShowInterviewMemo(true),
            },
            {
              label: "Unsaved notes…",
              icon: "edit",
              badge: unfinishedCount,
              section: "study",
              onSelect: () => setShowRecoveryPanel(true),
            },
            {
              label: "Study files…",
              icon: "folder",
              section: "study",
              onSelect: () => setShowProjectFiles(true),
            },
            ...(COLLABORATION_ENABLED
              ? [
                  {
                    label: "Study & sync…",
                    icon: "people" as const,
                    section: "study",
                    onSelect: () => openSyncSheet(),
                  },
                ]
              : []),
            {
              label: "Backups…",
              icon: "layers",
              section: "study",
              onSelect: () => setShowBackups(true),
            },
            {
              label: "Activity log…",
              icon: "clock",
              section: "study",
              onSelect: () => setShowActivityLog(true),
            },
            {
              label: "Close study",
              icon: "close",
              section: "study",
              onSelect: () => requestCloseProject(),
            },
            {
              label: "Settings…",
              icon: "settings",
              section: "app",
              onSelect: () => openSettings(),
            },
            {
              label: describeUpdateAction(updateStatus).label,
              icon: "refresh",
              section: "app",
              onSelect: () => void useUpdateStore.getState().runPrimaryAction(),
            },
            {
              label: "User guide",
              icon: "book",
              shortcut: "?",
              section: "app",
              onSelect: () => openGuide("workspace-overview"),
            },
            {
              label: "Reset coding…",
              icon: "trash",
              onSelect: () => requestResetWorkspace(),
              destructive: true,
            },
          ]}
        />
      </div>
    </header>
  );
}
