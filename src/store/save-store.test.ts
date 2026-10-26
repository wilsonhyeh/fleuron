import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  api: {
    noteRecoveryStatus: vi.fn().mockResolvedValue({ available: true, error: null }),
    listNoteDrafts: vi.fn().mockResolvedValue([]),
    beginNoteDraft: vi.fn(),
    putNoteDraft: vi.fn(),
    discardNoteDraft: vi.fn(),
    saveNoteDraft: vi.fn(),
    resolveNoteDraftTarget: vi.fn(),
    saveOpenProject: vi.fn().mockResolvedValue(true),
  },
}));

import { api } from "../lib/api";
import { useSaveStore } from "./save-store";
import { useNoteDraftStore, type NoteDraftEntry } from "./note-draft-store";

function dirtyEntry(key: string, targetId: string, text = "unsaved"): NoteDraftEntry {
  return {
    key,
    projectKey: "proj-1",
    kind: "coding",
    targetId,
    interviewId: "iv-1",
    epoch: "epoch-1",
    draftId: `draft-${targetId}`,
    revision: 1,
    ackedRevision: 1,
    baseText: "",
    draftText: text,
    saveState: "dirty",
    saveError: null,
    conflictText: null,
    targetMissing: false,
    epochStale: false,
    recoveryState: "backed-up",
    recoveryError: null,
    putInFlight: false,
    queuedText: null,
    saveInFlight: false,
    saveQueued: false,
    discardRequested: false,
    context: {
      coderName: "Ada",
      participantLabel: "P01",
      segmentId: "seg-1",
      segmentIndex: 0,
      charStart: null,
      charEnd: null,
      quoteText: null,
    },
    updatedAt: Date.now(),
  };
}

function seed(entries: NoteDraftEntry[]) {
  useNoteDraftStore.setState({
    workspace: { projectKey: "proj-1", epoch: "epoch-1" },
    entries: Object.fromEntries(entries.map((e) => [e.key, e])),
    frozen: false,
  });
}

const key = (id: string) => `proj-1::coding::${id}`;

beforeEach(() => {
  vi.clearAllMocks();
  useNoteDraftStore.getState().clearWorkspace();
  useSaveStore.setState({ status: "idle", error: null, inFlight: null });
  vi.mocked(api.saveOpenProject).mockResolvedValue(true);
  vi.mocked(api.saveNoteDraft).mockImplementation(async (input: {
    draft_id: string;
    revision: number;
    draft_text: string;
  }) => ({
    status: "saved",
    draft_id: input.draft_id,
    revision: input.revision,
    committed_text: input.draft_text,
    recovery_cleared: true,
  }));
});

describe("save-store", () => {
  it("commits every dirty note, then writes the study file", async () => {
    seed([dirtyEntry(key("c1"), "c1"), dirtyEntry(key("c2"), "c2")]);
    const outcome = await useSaveStore.getState().saveAll();
    expect(outcome).toMatchObject({ saved: 2, conflicts: 0, failed: 0 });
    expect(vi.mocked(api.saveNoteDraft)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.saveOpenProject)).toHaveBeenCalledTimes(1);
    expect(useNoteDraftStore.getState().dirtyEntries()).toHaveLength(0);
    expect(useSaveStore.getState().status).toBe("saved");
  });

  it("writes the study file even with no notes to save", async () => {
    useNoteDraftStore.getState().bindWorkspace("proj-1", "epoch-1");
    await useSaveStore.getState().saveAll();
    expect(vi.mocked(api.saveNoteDraft)).not.toHaveBeenCalled();
    expect(vi.mocked(api.saveOpenProject)).toHaveBeenCalledTimes(1);
  });

  it("coalesces the menu accelerator and the webview keydown into one save", async () => {
    seed([dirtyEntry(key("c1"), "c1")]);
    const a = useSaveStore.getState().saveAll();
    const b = useSaveStore.getState().saveAll();
    expect(a).toBe(b);
    await a;
    expect(vi.mocked(api.saveNoteDraft)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.saveOpenProject)).toHaveBeenCalledTimes(1);
  });

  it("leaves a conflicted note on its entry and reports it, without a prompt", async () => {
    seed([dirtyEntry(key("c1"), "c1"), dirtyEntry(key("c2"), "c2")]);
    vi.mocked(api.saveNoteDraft).mockResolvedValueOnce({
      status: "conflict",
      current_text: "theirs",
    } as never);
    const outcome = await useSaveStore.getState().saveAll();
    expect(outcome).toMatchObject({ saved: 1, conflicts: 1 });
    expect(useNoteDraftStore.getState().entries[key("c1")].saveState).toBe("conflict");
    expect(useSaveStore.getState().status).toBe("error");
    expect(useSaveStore.getState().error).toMatch(/changed elsewhere/);
    expect(vi.mocked(api.saveOpenProject)).toHaveBeenCalledTimes(1);
  });

  it("reports a failed study-file write instead of claiming Saved", async () => {
    useNoteDraftStore.getState().bindWorkspace("proj-1", "epoch-1");
    vi.mocked(api.saveOpenProject).mockRejectedValueOnce("Could not write the study file: disk I/O error");
    const outcome = await useSaveStore.getState().saveAll();
    expect(outcome.failed).toBe(1);
    expect(useSaveStore.getState().status).toBe("error");
    expect(useSaveStore.getState().error).toMatch(/disk I\/O/);
  });

  it("skips drafts whose original is gone; they stay in Unfinished notes", async () => {
    const orphan = { ...dirtyEntry(key("c1"), "c1"), targetMissing: true };
    seed([orphan]);
    await useSaveStore.getState().saveAll();
    expect(vi.mocked(api.saveNoteDraft)).not.toHaveBeenCalled();
    expect(useSaveStore.getState().status).toBe("saved");
  });
});
