import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { UpdateCoordinatorStatus } from "../lib/types";
import { describeUpdateAction, UpdateAction, updateNeedsAttention } from "./UpdateAction";

const base: UpdateCoordinatorStatus = {
  phase: "idle",
  currentVersion: "0.27.0",
  targetVersion: null,
  downloadedBytes: 0,
  totalBytes: null,
  lastCheckedAt: null,
  syncPreflightOutcome: null,
  failure: null,
};

describe("v0.27 visible update actions", () => {
  it("uses the required state copy, including byte progress and preflight saving", () => {
    expect(describeUpdateAction({ ...base, phase: "available", targetVersion: "0.28.0" }).label)
      .toBe("Update available");
    expect(describeUpdateAction({
      ...base,
      phase: "downloading",
      downloadedBytes: 42,
      totalBytes: 100,
    }).label).toBe("Downloading 42%");
    expect(describeUpdateAction({ ...base, phase: "readyToInstall" }).label)
      .toBe("Ready—restart to update");
    expect(describeUpdateAction({ ...base, phase: "preparing" }).label)
      .toBe("Saving changes before update…");
    expect(describeUpdateAction({
      ...base,
      phase: "preparing",
      syncPreflightOutcome: "offline_or_failed",
    }).label).toBe("Preparing update…");
    expect(describeUpdateAction({
      ...base,
      phase: "failed",
      failure: { stage: "install", retryable: true, message: "Synthetic failure" },
    }).label).toBe("Update failed—retry");
  });

  it("keeps an accessible narrow-toolbar affordance when its label is hidden", () => {
    const html = renderToStaticMarkup(createElement(UpdateAction, { compact: true }));

    expect(html).toContain('aria-label="Update: Check for updates"');
    expect(html).toContain("min-[1280px]:inline");
    expect(html).toContain("data-testid=\"update-action\"");
  });

  it("hideWhenIdle shows the button only when an update needs attention", () => {
    expect(updateNeedsAttention(null, false)).toBe(false);
    expect(updateNeedsAttention({ ...base, phase: "idle" }, true)).toBe(false);
    // A silent background check stays silent; one the user started shows.
    expect(updateNeedsAttention({ ...base, phase: "checking" }, false)).toBe(false);
    expect(updateNeedsAttention({ ...base, phase: "checking" }, true)).toBe(true);
    for (const phase of ["available", "downloading", "readyToInstall", "preparing", "installing", "failed"] as const) {
      expect(updateNeedsAttention({ ...base, phase }, false)).toBe(true);
    }
    // Initial store state is idle: the toolbar renders nothing.
    expect(
      renderToStaticMarkup(createElement(UpdateAction, { compact: true, hideWhenIdle: true })),
    ).toBe("");
  });

  it("keeps all required entry points and removes the bottom-viewport pill", () => {
    const source = (relative: string) => readFileSync(
      fileURLToPath(new URL(relative, import.meta.url)),
      "utf8",
    );
    const toolbar = source("./Toolbar.tsx");
    const home = source("./WelcomeScreen.tsx");
    const settings = source("./SettingsSheet.tsx");
    const app = source("../App.tsx");

    // The workspace toolbar shows the button only when an update needs
    // action; "Check for updates" is always reachable from More actions.
    expect(toolbar.indexOf("<SyncChip />")).toBeLessThan(
      toolbar.indexOf("<UpdateAction compact hideWhenIdle />"),
    );
    expect(toolbar).toContain("describeUpdateAction(updateStatus).label");
    expect(home).toContain("<UpdateAction />");
    expect(settings).toContain("<UpdateStatus />");
    expect(app).toContain("<UpdatePreparationOverlay />");
    expect(app).not.toContain("UpdateAvailablePill");
  });
});
