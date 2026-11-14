import { expect, test } from "@playwright/test";
import { resetDemo } from "./helpers";

test.beforeEach(async ({ page }) => resetDemo(page));

test("editor: keyboard placement, route preview, checklist, publish v2", async ({ page }) => {
  await page.goto("/business/floor-plan");
  await page.getByRole("button", { name: "Edit draft" }).click();
  await expect(page.getByText("Editing draft · based on published v1")).toBeVisible();

  // Place a walk point with the keyboard (Enter places at the centre of the view), then delete it.
  await page.getByRole("button", { name: "+ Walk point" }).click();
  await page.getByRole("application", { name: /Floor plan/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Walk point N18" })).toBeVisible();
  await expect(page.getByText("No walkable connections yet. Use Connect paths.")).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Walk point N18" })).toHaveCount(0);

  // Route preview uses only drawn edges.
  await page.getByLabel("From the entrance to").selectOption("S-A4-2");
  await expect(page.getByText("Route: N01 → N02 → N03 → N04 → N15 → N16 (5 connections).", { exact: false })).toBeVisible();

  // The seeded map passes the checklist; publish creates v2.
  await expect(page.getByRole("heading", { name: "Ready to publish" })).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  const dlg = page.getByRole("alertdialog", { name: "Publish floor plan v2?" });
  await dlg.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Floor plan v2 published." })).toBeVisible();
  await expect(page.getByText(/^Published v2 · 12 shelves/)).toBeVisible();

  // Shopper routing still works over the newly published graph (existing POST /api/routes contract).
  const r = await page.request.post("/api/routes", { data: { store_id: "demo-store", start_node_id: "N01", product_id: "P21" } });
  expect(r.status()).toBe(200);
  expect((await r.json()).mapVersion).toBe(2);
});

test("editor: removing a shelf that holds verified products blocks publishing", async ({ page }) => {
  await page.goto("/business/floor-plan");
  await page.getByRole("button", { name: "Edit draft" }).click();
  await page.getByRole("button", { name: /Aisle 1 · Section 1/ }).click(); // text list selects in edit mode
  await expect(page.getByRole("heading", { name: "Shelf S-A1-1" })).toBeVisible();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Needs correction: Every shelf with verified products is placed")).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeDisabled();
});
