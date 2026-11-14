import { expect, test } from "@playwright/test";

// The e2e server runs in memory mode (no Supabase env): the manager app stays open and sign-in is a no-op page.

test("memory mode: manager app opens without sign-in and shows no session bar", async ({ page }) => {
  await page.goto("/business");
  await expect(page).toHaveURL(/\/business$/);
  await expect(page.getByRole("navigation", { name: "Manager" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});

test("memory mode: sign-in page explains it isn't needed, without the manager nav", async ({ page }) => {
  await page.goto("/business/sign-in");
  await expect(page.getByRole("heading", { level: 1, name: "Staff sign-in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign-in isn’t needed in demo mode" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Manager" })).toHaveCount(0);
  await page.getByRole("link", { name: "Open the manager app" }).click();
  await expect(page.getByRole("navigation", { name: "Manager" })).toBeVisible();
});
