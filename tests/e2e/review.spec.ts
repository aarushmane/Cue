import { expect, test } from "@playwright/test";
import { openObservation, publish, resetDemo, verifyBoth } from "./helpers";

test.beforeEach(async ({ page }) => resetDemo(page));

test("oat milk merge → publish → removed from Pending → Inventory and Activity updated → found in shopper search", async ({ page }) => {
  await openObservation(page, /^Oatly Oatmilk\./);
  await expect(page.getByRole("heading", { name: "! Possible existing product found." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve and Publish" })).toBeDisabled();
  await page.getByRole("button", { name: "Merge with this product" }).click();
  await expect(page.getByRole("button", { name: "✓ Merging with this product" })).toHaveAttribute("aria-pressed", "true");
  await page.getByLabel("Product name (required)").fill("Oat Milk");
  await verifyBoth(page);
  await publish(page);
  await expect(page.getByText("✓ Successfully published")).toBeVisible();
  await expect(page.getByText("Oat Milk is verified at Aisle 2, Section 2, middle shelf.", { exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Back to queue" }).click();
  await expect(page.getByRole("button", { name: "Pending (4)" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Oatly Oatmilk\./ })).toHaveCount(0);

  await page.getByRole("navigation", { name: "Manager" }).getByRole("link", { name: "More" }).click();
  await page.getByRole("link", { name: /Activity/ }).click();
  await expect(page.getByRole("listitem").first()).toContainText("Oat Milk verified at Aisle 2, Section 2 (OBS-104)");
  await page.getByRole("button", { name: /Oat Milk verified/ }).click();
  await expect(page.getByText("Original observation")).toBeVisible();

  await page.goto("/shopper?q=oatly%20oat%20milk");
  await expect(page.getByRole("heading", { level: 1, name: "Oat Milk" })).toBeFocused();
  await expect(page.getByText("Aisle 2, Section 2, middle shelf").first()).toBeVisible();
});

test("duplicate observation can be confirmed as a genuinely new product", async ({ page }) => {
  await openObservation(page, /^Califia Farms Oat Milk Barista Blend\./);
  await expect(page.getByRole("heading", { name: "! Possible existing product found." })).toBeVisible();
  await page.getByRole("button", { name: "Confirm it is a new product" }).click();
  await verifyBoth(page);
  await publish(page);
  await expect(page.getByText("✓ Successfully published")).toBeVisible();
  await page.getByRole("button", { name: "View Published Inventory" }).click();
  await expect(page.getByRole("button", { name: /^Oat Milk Barista Blend,/ })).toBeVisible();
});

test("editing product details clears the identity confirmation", async ({ page }) => {
  await openObservation(page, /^Califia Farms/);
  await page.getByRole("checkbox", { name: "I have verified the product identity." }).check();
  await page.getByRole("textbox", { name: "Size", exact: true }).fill("48 oz");
  await expect(page.getByRole("checkbox", { name: "I have verified the product identity." })).not.toBeChecked();
  await expect(page.getByText("! Product details changed, so this confirmation was cleared.")).toBeVisible();
});

test("invalid location blocks publishing with text explanations", async ({ page }) => {
  await openObservation(page, /^Unidentified product\./);
  await expect(page.getByRole("button", { name: "Approve and Publish" })).toBeDisabled();
  await expect(page.getByText("Needs correction: Exact aisle, shelf section and level selected")).toBeVisible();
  await expect(page.getByText("The location is unknown or approximate.", { exact: false })).toBeVisible();
});

test("reject requires a reason and leaves inventory unchanged", async ({ page }) => {
  await openObservation(page, /^Unidentified product\./);
  await page.getByRole("button", { name: "Reject observation" }).click();
  const sheet = page.getByRole("dialog", { name: "Reject observation" });
  await expect(sheet.getByRole("button", { name: "Reject observation" })).toBeDisabled();
  await sheet.getByRole("button", { name: "Wrong product identified" }).click();
  await sheet.getByRole("button", { name: "Reject observation" }).click();
  await expect(page.getByText("✕ Observation rejected")).toBeVisible();
  await expect(page.getByText("Official inventory was not changed.", { exact: false })).toBeVisible();
});

test("rescan sets NEEDS_RESCAN", async ({ page }) => {
  await openObservation(page, /^Jif Creamy Peanut Butter\./);
  await page.getByRole("button", { name: "Request rescan" }).click();
  const sheet = page.getByRole("dialog", { name: "Request rescan" });
  await sheet.getByRole("button", { name: "Size label not visible" }).click();
  await sheet.getByRole("button", { name: "Request rescan" }).click();
  await expect(page.getByText("↻ Rescan requested")).toBeVisible();
  await page.getByRole("button", { name: "Back to queue" }).click();
  await page.getByRole("button", { name: /^Reviewed/ }).click();
  await expect(page.getByRole("button", { name: /Jif Creamy Peanut Butter.*Rescan requested/ })).toBeVisible();
});

test("another employee approved first → 409 banner, nothing published", async ({ page }) => {
  await openObservation(page, /^Chobani Greek Yogurt\./);
  await page.getByRole("button", { name: "Merge with this product" }).first().click();
  await verifyBoth(page);
  await publish(page);
  await expect(page.getByText("! Already reviewed by another employee")).toBeVisible();
  await expect(page.getByText(/Marcus T\., Staff approved this observation/)).toBeVisible();
});

test("server failure shows the error, changes nothing, and Try again succeeds once fixed", async ({ page }) => {
  await page.getByRole("checkbox", { name: /Simulate a publishing failure/ }).check();
  await openObservation(page, /^Califia Farms/);
  await page.getByRole("button", { name: "Confirm it is a new product" }).click();
  await verifyBoth(page);
  await publish(page);
  const sheet = page.getByRole("dialog", { name: "Publish to inventory?" });
  await expect(sheet.getByRole("alert")).toContainText("! Publishing failed");
  await expect(sheet.getByRole("button", { name: "Try again" })).toBeVisible();
  await sheet.getByRole("button", { name: "Cancel" }).click();

  await page.getByRole("navigation", { name: "Manager" }).getByRole("link", { name: "More" }).click();
  await page.getByRole("checkbox", { name: /Simulate a publishing failure/ }).uncheck();
  await page.getByRole("navigation", { name: "Manager" }).getByRole("link", { name: "Review" }).click();
  // Switching tabs keeps the unsaved draft (only "‹ Queue" discards it), so the employee can retry directly.
  await page.getByRole("button", { name: /^Califia Farms/ }).click();
  await expect(page.getByRole("checkbox", { name: "I have verified the product identity." })).toBeChecked();
  await publish(page);
  await expect(page.getByText("✓ Successfully published")).toBeVisible();
});

test("back to queue discards unsaved edits; Save details keeps them without publishing", async ({ page }) => {
  await openObservation(page, /^Jif Creamy Peanut Butter\./);
  await page.getByRole("textbox", { name: "Size", exact: true }).fill("16 oz");
  await page.getByRole("button", { name: "‹ Queue" }).click();
  await page.getByRole("button", { name: /^Jif Creamy Peanut Butter\./ }).click();
  await expect(page.getByRole("textbox", { name: "Size", exact: true })).toHaveValue("");
  await page.getByRole("textbox", { name: "Size", exact: true }).fill("16 oz");
  await page.getByRole("button", { name: "Save details" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Details saved. Nothing was published." })).toBeVisible();
  await page.getByRole("button", { name: "‹ Queue" }).click();
  await expect(page.getByRole("button", { name: /Details saved, not published\./ })).toBeVisible();
  await page.getByRole("button", { name: /^Jif Creamy Peanut Butter\./ }).click();
  await expect(page.getByRole("textbox", { name: "Size", exact: true })).toHaveValue("16 oz");
});

test("inventory move: publish is disabled until changed, then confirm writes the move", async ({ page }) => {
  await page.getByRole("link", { name: /Inventory/ }).click();
  await page.getByLabel("Search products").fill("bagel");
  await page.getByRole("button", { name: /^Plain Bagels,/ }).click();
  const sheet = page.getByRole("dialog", { name: "Plain Bagels" });
  await expect(sheet.getByRole("button", { name: "Review and publish" })).toBeDisabled();
  await sheet.getByLabel("Shelf level").selectOption("lower");
  await sheet.getByRole("button", { name: "Review and publish" }).click();
  const dlg = page.getByRole("alertdialog", { name: "Publish this move?" });
  await expect(dlg).toContainText("Aisle 1, Section 2, upper shelf");
  await dlg.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published. Shopper routes for Plain Bagels" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Plain Bagels,.*lower shelf/ })).toBeVisible();
});
