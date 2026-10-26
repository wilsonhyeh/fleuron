import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../store/project-store";
import { shortcut } from "../lib/platform";
import { Icon } from "./ui/Icon";
import { Tooltip } from "./ui/Tooltip";

/**
 * Back / Forward through interview history, beside the Current interview
 * selector they walk. They used to sit in the window toolbar between the study
 * title and a second copy of the participant name. The ⌘[ / ⌘] shortcuts stay
 * in Toolbar, which is mounted for the whole workspace.
 */
export function InterviewHistoryNav() {
  const { interviewHistory, historyCursor, goBackInterview, goForwardInterview } =
    useProjectStore(
      useShallow((s) => ({
        interviewHistory: s.interviewHistory,
        historyCursor: s.historyCursor,
        goBackInterview: s.goBackInterview,
        goForwardInterview: s.goForwardInterview,
      })),
    );

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tooltip content={`Back (${shortcut("mod", "[")})`}>
        <button
          type="button"
          disabled={historyCursor <= 0}
          onClick={() => void goBackInterview()}
          aria-label="Back"
          title={`Back (${shortcut("mod", "[")})`}
          className="btn btn-ghost btn-sm grid h-6 w-6 place-items-center rounded p-0 text-[var(--ink-3)] hover:text-[var(--ink)] disabled:opacity-30"
        >
          <Icon name="chevronLeft" size={13} />
        </button>
      </Tooltip>
      <Tooltip content={`Forward (${shortcut("mod", "]")})`}>
        <button
          type="button"
          disabled={historyCursor < 0 || historyCursor >= interviewHistory.length - 1}
          onClick={() => void goForwardInterview()}
          aria-label="Forward"
          title={`Forward (${shortcut("mod", "]")})`}
          className="btn btn-ghost btn-sm grid h-6 w-6 place-items-center rounded p-0 text-[var(--ink-3)] hover:text-[var(--ink)] disabled:opacity-30"
        >
          <Icon name="chevronRight" size={13} />
        </button>
      </Tooltip>
    </div>
  );
}
