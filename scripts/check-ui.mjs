import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { PNG } from "pngjs";

const url = process.env.APP_URL || "http://localhost:3000";
const output = path.resolve(process.env.UI_ARTIFACTS_DIR || ".artifacts/design-system");
// Set PW_CHANNEL=chromium to use Playwright's bundled browser when Google Chrome is not installed.
const channel = process.env.PW_CHANNEL || "chrome";
await mkdir(output, { recursive: true });

function assertRendered(buffer) {
  const png = PNG.sync.read(buffer);
  const colors = new Set();
  let lit = 0;
  for (let i = 0; i < png.data.length; i += 16) {
    const [r, g, b] = png.data.subarray(i, i + 3);
    colors.add(`${r},${g},${b}`);
    if (Math.max(r, g, b) > 60) lit++;
  }
  assert(colors.size > 30, "The tour should contain varied rendered pixels.");
  assert(lit / (png.width * png.height / 4) > 0.15, "The tour should occupy a meaningful part of the viewport.");
}

const browser = await chromium.launch({ ...(channel === "chromium" ? {} : { channel }), headless: true });
const results = [];
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const label = viewport.width > 600 ? "desktop" : "mobile";
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(url);
    assert.equal(response.status(), 200);
    // Showcase embed when an SDK key is set (or the 360° photos are unavailable), otherwise the built-in 360° viewer.
    const embed = page.locator("iframe.scene-embed, canvas[role=img]").first();
    const reset = page.getByRole("button", { name: "Reset view", exact: true });
    await expect(reset).toBeEnabled({ timeout: 30_000 }).catch(async (error) => {
      console.log("Load failure:", label, await page.locator("body").innerText(), errors);
      await page.screenshot({ path: path.join(output, `${label}-failure.png`) });
      throw error;
    });
    await expect(embed).toBeVisible();
    if (await embed.evaluate((el) => el.tagName === "IFRAME")) {
      assert.match(await embed.getAttribute("src"), /^https:\/\/my\.matterport\.com\/show\/\?m=[a-zA-Z0-9]{11}&/, "The scene is the Matterport Showcase embed.");
    }

    const bounds = await embed.boundingBox();
    assert.equal(Math.round(bounds.width), viewport.width);
    assert.equal(Math.round(bounds.height), viewport.height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No horizontal overflow.");
    assert.equal((await reset.boundingBox()).width, 44, "Icon targets should be 44 px.");
    const toolbar = page.getByRole("group", { name: "Scene tools" });
    const tools = await toolbar.boundingBox();
    assert(tools.x >= 0 && tools.y >= 0 && tools.x + tools.width <= viewport.width && tools.y + tools.height <= viewport.height);
    assert.equal(await page.locator("body").innerText().then((text) => /WASD|Drag to look|Click to focus/.test(text)), false);

    // Showcase renders inside the frame; give it time to draw the start point before capturing.
    await page.waitForTimeout(8_000);
    const shot = await page.screenshot({ path: path.join(output, `${label}.png`) });
    assertRendered(shot);

    // Reset reloads the tour at its start point.
    await reset.click();
    await expect(reset).toBeEnabled({ timeout: 30_000 });
    await page.mouse.move(8, 8);
    await expect(page.getByRole("tooltip")).toBeHidden();
    await reset.hover();
    await expect(page.getByRole("tooltip")).toHaveText("Reset view");
    await page.keyboard.press("Escape");
    await page.mouse.move(8, 8);
    await expect(page.getByRole("tooltip")).toBeHidden();

    await page.getByRole("button", { name: "Enter fullscreen" }).click();
    await expect(page.getByRole("button", { name: "Exit fullscreen" })).toBeVisible();
    await page.getByRole("button", { name: "Exit fullscreen" }).click();
    await expect(page.getByRole("button", { name: "Enter fullscreen" })).toBeVisible();

    const theme = await page.evaluate(() => {
      const root = document.documentElement;
      const dark = getComputedStyle(document.body).backgroundColor;
      root.classList.remove("dark");
      const light = getComputedStyle(document.body).backgroundColor;
      root.classList.add("dark");
      return { dark, light, letterSpacing: getComputedStyle(document.body).letterSpacing };
    });
    assert.notEqual(theme.dark, theme.light, "Both token modes must be wired to the UI.");
    assert(["0px", "normal"].includes(theme.letterSpacing), "No additional or negative letter spacing.");
    assert.deepEqual(errors, []);
    results.push({ viewport: label, embed: true, rendered: true, reset: true, tooltip: true, fullscreen: true, noOverflow: true });
    await page.close();
  }

  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, artifacts: output, results }, null, 2));
} finally {
  await browser.close();
}
