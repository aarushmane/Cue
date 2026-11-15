import { expect, test } from "@playwright/test";
import { openObservation, publish, resetDemo, verifyBoth } from "./helpers";

test.beforeEach(async ({ page }) => resetDemo(page));

test("shopper consent → scan → submit → employee approves → on the floor plan shelf → shopper search 'skyr'", async ({ page, context }) => {
  // Consent and scan.
  await page.goto("/shopper");
  await page.getByRole("button", { name: "Help map this store" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Contribute product information?" })).toBeFocused();
  await page.getByRole("button", { name: "Allow Product Contributions" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Help map this store" })).toBeVisible();
  await expect(page.getByText("Scanning: Off. Nothing is being collected.")).toBeVisible();
  await context.grantPermissions([]); // camera stays unavailable/blocked in CI; demo recognition still works
  await page.getByRole("button", { name: "Start observation scan" }).click();
  await expect(page.getByText("Scanning: On. Nothing is sent until you choose Submit.")).toBeVisible();
  await page.getByRole("button", { name: "Identify product in view" }).click();
  await expect(page.getByRole("heading", { name: "Siggi's Vanilla Skyr" })).toBeVisible();
  await page.getByRole("button", { name: "Submit for staff review" }).click();
  await expect(page.locator("main").getByText(/^Sent as OBS-106\./)).toBeVisible();

  // Same brand + name + shelf as a pending observation → a sighting, not a duplicate.
  await page.getByRole("button", { name: "Identify product in view" }).click();
  await page.getByRole("button", { name: "Submit for staff review" }).click();
  await expect(page.locator("main").getByText(/Added as another sighting of OBS-105/)).toBeVisible();
  await page.getByRole("button", { name: "End scan" }).click();
  await expect(page.getByText("Camera: not in use.")).toBeVisible();

  // Not yet searchable: unreviewed observations are never used.
  await page.goto("/shopper");
  await page.getByLabel("Type a product").fill("skyr");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("#mic-status")).toContainText('No product found for "skyr"');

  // Employee approves.
  await page.goto("/business");
  await openObservation(page, /^Siggi's Vanilla Skyr\./);
  // No similar product exists, so there is no duplicate panel: the employee records "new" in the match field.
  await expect(page.getByRole("heading", { name: "! Possible existing product found." })).toHaveCount(0);
  await page.getByLabel("Existing inventory match (required)").selectOption("new");
  await page.getByLabel("Shelf level").selectOption("middle");
  await verifyBoth(page);
  await publish(page);
  await expect(page.getByText("✓ Successfully published")).toBeVisible();

  // Appears on the shelf in the floor plan.
  await page.getByRole("button", { name: "Show on floor plan" }).click();
  const shelf = page.getByRole("dialog", { name: "Aisle 2 · Section 3" });
  await expect(shelf.getByRole("button", { name: /Vanilla Skyr/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(shelf).toHaveCount(0);

  // Shopper search finds it.
  await page.goto("/shopper");
  await page.getByLabel("Type a product").fill("skyr");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Vanilla Skyr" })).toBeFocused();
  await expect(page.getByText("Aisle 2, Section 3, middle shelf").first()).toBeVisible();
});

test("declining contributions returns to search and search still works", async ({ page }) => {
  await page.goto("/shopper");
  await page.getByRole("button", { name: "Help map this store" }).click();
  await page.getByRole("button", { name: "Continue Without Contributing" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "What can I help you find?" })).toBeVisible();
  await page.getByRole("button", { name: "Accessibility and privacy settings" }).click();
  await expect(page.getByRole("button", { name: "✓ Not allowed" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "‹ Back" }).click();
  await page.getByLabel("Type a product").fill("almond milk");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: /2 matches for “almond milk”/ })).toBeFocused();
  await page.getByRole("button", { name: /^Option 1:/ }).click();
  await expect(page.getByText("✓ VERIFIED DESTINATION")).toBeVisible();
});

test("contribution choice starts unselected and persists on this device", async ({ page }) => {
  await page.goto("/shopper/settings");
  await expect(page.getByRole("button", { name: "Allowed", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByRole("button", { name: "Not allowed", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Not chosen yet. Nothing is collected.")).toBeVisible();
  await page.getByRole("button", { name: "Allowed", exact: true }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: "✓ Allowed" })).toHaveAttribute("aria-pressed", "true");
});

test("location updated by staff is announced on the destination screen", async ({ page, browser }) => {
  await page.goto("/shopper");
  await page.getByLabel("Type a product").fill("bagels");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Plain Bagels" })).toBeVisible();

  const staff = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await staff.goto("/business/inventory");
  await staff.getByRole("button", { name: /^Plain Bagels,/ }).click();
  await staff.getByLabel("Shelf level").selectOption("lower");
  await staff.getByRole("button", { name: "Review and publish" }).click();
  await staff.getByRole("alertdialog").getByRole("button", { name: "Publish" }).click();
  await expect(staff.getByRole("status").filter({ hasText: "Published." })).toBeVisible();
  await staff.close();

  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByRole("alert").filter({ hasText: "Location updated" })).toContainText("! Location updated by staff. The destination is now Aisle 1, Section 2, lower shelf.");
  await page.getByRole("button", { name: "Hear location" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Location updated" })).toHaveCount(0);
});
