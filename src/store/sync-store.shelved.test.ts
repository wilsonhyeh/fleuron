/**
 * With collaboration shelved, the sync store must never reach the backend:
 * no sign-in restore, no status (so every "in a group?" check reads false),
 * no sync run, and no sheet.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/features", () => ({ COLLABORATION_ENABLED: false }));

vi.mock("../lib/api", () => ({
  api: {
    syncRestoreSession: vi.fn(),
    syncStatus: vi.fn(),
    syncNow: vi.fn(),
    syncGroupInfo: vi.fn(),
    syncV2Readiness: vi.fn(),
  },
}));

vi.mock("./project-store", () => ({
  useProjectStore: { getState: () => ({ project: null }) },
}));

import { api } from "../lib/api";
import { useSyncStore } from "./sync-store";

describe("sync store with collaboration shelved", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSyncStore.setState({ status: null, sessionRestoreComplete: false, showSyncSheet: false });
  });

  it("settles the session restore without asking the backend", async () => {
    await useSyncStore.getState().restoreSession();
    expect(api.syncRestoreSession).not.toHaveBeenCalled();
    expect(api.syncStatus).not.toHaveBeenCalled();
    expect(useSyncStore.getState().sessionRestoreComplete).toBe(true);
    expect(useSyncStore.getState().status).toBeNull();
  });

  it("never fetches status, syncs, upgrades, or opens the sheet", async () => {
    await useSyncStore.getState().refreshStatus();
    await useSyncStore.getState().refreshGroup();
    await useSyncStore.getState().syncNow({ silent: true });
    await useSyncStore.getState().maybeAutoActivateV2();
    useSyncStore.getState().openSyncSheet();

    expect(api.syncStatus).not.toHaveBeenCalled();
    expect(api.syncGroupInfo).not.toHaveBeenCalled();
    expect(api.syncNow).not.toHaveBeenCalled();
    expect(api.syncV2Readiness).not.toHaveBeenCalled();
    expect(useSyncStore.getState().showSyncSheet).toBe(false);
    expect(useSyncStore.getState().status).toBeNull();
  });
});
