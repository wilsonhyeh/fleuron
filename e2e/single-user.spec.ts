import { test, expect } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";
import { COLLABORATION_ENABLED } from "../src/lib/features";

/**
 * Collaboration is shelved: nothing a person can see offers to sign in,
 * share, join or sync. Checked from the screens, not the store.
 */
test.skip(COLLABORATION_ENABLED, "Only applies while collaboration is shelved");

const COLLAB_WORDS = /Join with a key|Join a collaborative study|Share with a group|Shared with a group|Sign in|Study & sync/i;

test("home screen lists studies with no account, join or share actions", async ({ page }) => {
  await gotoApp(page);
  await expect(page.getByRole("button", { name: /Sample Study/ }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("heading", { name: "Studies" })).toBeVisible();
  await expect(page.getByRole("button", { name: COLLAB_WORDS })).toHaveCount(0);
  await expect(page.getByText(/Shared with a group/i)).toHaveCount(0);
});

test("workspace shows no sync chip or sync menu, and Settings has no account", async ({ page }) => {
  await gotoApp(page);
  await openWorkspace(page);

  await expect(page.getByRole("button", { name: /Synced|Syncing|to send|Never synced|Not in a group|Offline/i })).toHaveCount(0);

  await page.getByRole("button", { name: "More actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Study files…" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /sync/i })).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Settings…" }).click();

  const settings = page.getByLabel("Settings", { exact: true });
  await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Appearance" })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Account" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: /Sign in|Create account/i })).toHaveCount(0);
});
