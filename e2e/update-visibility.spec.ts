import { expect, test } from "@playwright/test";
import { gotoApp, openWorkspace } from "./helpers/workspace";

test.describe("v0.27 update action visibility", () => {
  test("remains reachable in narrow home and workspace top chrome", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 640 });
    await gotoApp(page);

    const homeAction = page.getByRole("button", { name: /Update: Check for updates/i });
    await expect(homeAction).toBeVisible();
    await expect(homeAction).toBeInViewport();

    // The workspace toolbar no longer carries a permanent check button (it
    // duplicated More actions); the check stays one menu away.
    await openWorkspace(page);
    await expect(page.getByRole("button", { name: /Update: Check for updates/i })).toHaveCount(0);
    await page.getByRole("button", { name: "More actions" }).click();
    const menuCheck = page.getByRole("menuitem", { name: "Check for updates" });
    await expect(menuCheck).toBeVisible();
    await expect(menuCheck).toBeInViewport();
  });
});
