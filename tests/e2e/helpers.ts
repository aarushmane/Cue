import { expect, type Page } from "@playwright/test";

export async function resetDemo(page: Page) {
  await page.goto("/business/more");
  await page.getByRole("button", { name: "Reset demo data" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Demo data reset to the seed." })).toBeVisible();
}

export async function openObservation(page: Page, title: RegExp | string) {
  await page.getByRole("navigation", { name: "Manager" }).getByRole("link", { name: "Review" }).click();
  await page.getByRole("button", { name: title }).first().click();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
}

export async function verifyBoth(page: Page) {
  await page.getByRole("checkbox", { name: "I have verified the product identity." }).check();
  await page.getByRole("checkbox", { name: "I have verified the exact shelf location." }).check();
}

export async function publish(page: Page) {
  await expect(page.getByRole("heading", { name: "Ready to publish" })).toBeVisible();
  await page.getByRole("button", { name: "Approve and Publish" }).click();
  const sheet = page.getByRole("dialog", { name: "Publish to inventory?" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: "Confirm and publish" }).click();
}
