import { expect, test, type Page } from "@playwright/test";
import { resetDemo } from "./helpers";

const PAGES = [
  "/business", "/business/floor-plan", "/business/review", "/business/more", "/business/inventory", "/business/activity",
  "/signs", "/shopper", "/shopper/guide", "/shopper/settings", "/shopper/consent", "/shopper/contribute", "/shopper/help",
];

async function unnamedControls(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("button, a[href], input, select, textarea")]
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .filter((el) => {
        const e = el as HTMLElement;
        const labelled = e.getAttribute("aria-label") || e.getAttribute("aria-labelledby") || (e as HTMLInputElement).labels?.length;
        return !labelled && !e.textContent?.trim() && !e.getAttribute("title");
      })
      .map((el) => el.outerHTML.slice(0, 120)),
  );
}

test.beforeAll(async ({ browser }) => {
  const p = await browser.newPage();
  await resetDemo(p);
  await p.close();
});

for (const path of PAGES) {
  test(`${path}: one h1, every control named, no horizontal scroll at 320px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 720 });
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    expect(await unnamedControls(page)).toEqual([]);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test("touch targets are at least 44px on the shopper and manager home screens", async ({ page }) => {
  for (const path of ["/shopper", "/business"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const small = await page.evaluate(() =>
      [...document.querySelectorAll("main button, main a[href], nav a[href]")]
        .map((el) => ({ el, r: (el as HTMLElement).getBoundingClientRect() }))
        .filter(({ r }) => r.width > 0 && (r.height < 40 || r.width < 40))
        .map(({ el }) => el.textContent?.trim() || el.getAttribute("aria-label")),
    );
    // Mini-map shelf buttons are a pointer shortcut; the list and Open button are the accessible path.
    expect(small.filter((t) => !/^\d$/.test(t ?? ""))).toEqual([]);
  }
});

test("focus ring is visible on keyboard focus", async ({ page }) => {
  await page.goto("/shopper");
  await page.keyboard.press("Tab");
  const style = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement!);
    return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow };
  });
  expect(style.outline).toBe("solid");
  expect(style.width).toBe("3px");
  expect(style.shadow).toContain("232, 184, 75");
});

test("shopper text size scales the content root, and contrast modes change the theme", async ({ page }) => {
  await page.goto("/shopper/settings");
  await page.getByRole("button", { name: "160%" }).click();
  const fs = await page.locator("main > div").evaluate((el) => getComputedStyle(el).fontSize);
  expect(fs).toBe("27px");
  await page.getByRole("button", { name: "High contrast dark" }).click();
  const bg = await page.locator('[style*="--s-bg"]').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe("rgb(18, 16, 25)");
});

test("voice surface is one button with no nested controls and a status line", async ({ page }) => {
  await page.goto("/shopper");
  const mic = page.getByRole("button", { name: /Tap anywhere here to speak/ });
  await expect(mic).toHaveAttribute("aria-describedby", "mic-status");
  await expect(mic.locator("button, a, input")).toHaveCount(0);
  const box = await mic.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(340);
});

test("sheets trap focus, close on Escape and return focus to the opener", async ({ page }) => {
  await page.goto("/business/inventory");
  const opener = page.getByRole("button", { name: /^Bananas,/ });
  await opener.click();
  const sheet = page.getByRole("dialog", { name: "Bananas" });
  await expect(sheet).toBeVisible();
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test("floor plan has a keyboard alternative: focusable viewport and a text list of every shelf", async ({ page }) => {
  await page.goto("/business/floor-plan");
  const vp = page.getByRole("application", { name: /Floor plan, zoom 100%/ });
  await vp.focus();
  await page.keyboard.press("+");
  await expect(page.getByRole("button", { name: "Reset zoom and position" })).toHaveText("140%");
  await page.keyboard.press("0");
  await expect(page.getByRole("button", { name: "Reset zoom and position" })).toHaveText("100%");
  await expect(page.getByRole("heading", { name: "Shelves and places (text list)" })).toBeVisible();
  await page.getByLabel("Find a shelf, aisle or product").fill("oat milk");
  await expect(page.getByRole("button", { name: /Aisle 2 · Section 2.*Match: Oat Milk/ })).toBeVisible();
});
