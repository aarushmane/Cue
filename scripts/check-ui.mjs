import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { PNG } from "pngjs";

const url = process.env.APP_URL || "http://localhost:3000";
const output = path.resolve(process.env.UI_ARTIFACTS_DIR || ".artifacts/design-system");
await mkdir(output, { recursive: true });

function difference(a, b) {
  const left = PNG.sync.read(a);
  const right = PNG.sync.read(b);
  assert.equal(left.data.length, right.data.length);
  let changed = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    if (Math.abs(left.data[i] - right.data[i]) + Math.abs(left.data[i + 1] - right.data[i + 1]) + Math.abs(left.data[i + 2] - right.data[i + 2]) > 20) changed++;
  }
  return changed / (left.width * left.height);
}

function assertRendered(buffer) {
  const png = PNG.sync.read(buffer);
  const colors = new Set();
  let lit = 0;
  for (let i = 0; i < png.data.length; i += 16) {
    const [r, g, b] = png.data.subarray(i, i + 3);
    colors.add(`${r},${g},${b}`);
    if (Math.max(r, g, b) > 60) lit++;
  }
  assert(colors.size > 30, "Canvas should contain varied rendered pixels.");
  assert(lit / (png.width * png.height / 4) > 0.15, "The scene should occupy a meaningful part of the canvas.");
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
try {
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    const label = viewport.width > 600 ? "desktop" : "mobile";
    const page = await browser.newPage({ viewport, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const response = await page.goto(url);
    assert.equal(response.status(), 200);
    const canvas = page.locator("canvas");
    const reset = page.getByRole("button", { name: "Reset view", exact: true });
    await expect(reset).toBeEnabled({ timeout: 30_000 }).catch(async (error) => {
      console.log("Load failure:", label, await page.locator("body").innerText(), errors);
      await page.screenshot({ path: path.join(output, `${label}-failure.png`) });
      throw error;
    });
    await expect(canvas).toBeVisible();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    const bounds = await canvas.boundingBox();
    assert.equal(Math.round(bounds.width), viewport.width);
    assert.equal(Math.round(bounds.height), viewport.height);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "No horizontal overflow.");
    assert.equal((await reset.boundingBox()).width, 44, "Icon targets should be 44 px.");
    const toolbar = page.getByRole("group", { name: "Scene tools" });
    const tools = await toolbar.boundingBox();
    assert(tools.x >= 0 && tools.y >= 0 && tools.x + tools.width <= viewport.width && tools.y + tools.height <= viewport.height);
    assert.equal(await page.locator("body").innerText().then((text) => /WASD|Drag to look|Click to focus/.test(text)), false);

    const before = await canvas.screenshot();
    assertRendered(before);
    await page.screenshot({ path: path.join(output, `${label}.png`) });
    await canvas.focus();
    await page.keyboard.down("w");
    await page.waitForTimeout(300); // Deliberately exercise time-based movement.
    await page.keyboard.up("w");
    const moved = await canvas.screenshot();
    const movement = difference(before, moved);
    assert(movement > 0.02, `Keyboard movement must change canvas pixels (${movement}).`);
    await writeFile(path.join(output, `${label}-moved.png`), moved);

    await reset.click();
    await page.mouse.move(8, 8);
    await expect(canvas).toBeFocused();
    await expect(page.getByRole("tooltip")).toBeHidden();
    const restored = await canvas.screenshot();
    assert(difference(before, restored) < 0.015, "Reset must restore the initial view.");

    await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.down();
    await page.mouse.move(viewport.width / 2 + 80, viewport.height / 2 + 30, { steps: 8 });
    await page.mouse.up();
    const rotated = await canvas.screenshot();
    assert(difference(restored, rotated) > 0.02, "Dragging must rotate the camera.");
    await reset.click();
    await page.mouse.move(8, 8);
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
    results.push({ viewport: label, rendered: true, movementPixelChange: movement, reset: true, drag: true, tooltip: true, fullscreen: true, noOverflow: true });
    await page.close();
  }

  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  await page.route("**/api/scenes/Muo5jpq44Xk", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The scene is temporarily unavailable." }) }));
  await page.goto(url);
  const sceneAlert = page.getByRole("main").getByRole("alert");
  await expect(sceneAlert).toContainText("Scene unavailable");
  await expect(sceneAlert).toContainText("temporarily unavailable");
  await page.screenshot({ path: path.join(output, "mobile-error.png") });
  await page.unroute("**/api/scenes/Muo5jpq44Xk");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: "Reset view" })).toBeEnabled({ timeout: 30_000 });
  await expect(sceneAlert).toHaveCount(0);
  await page.screenshot({ path: path.join(output, "mobile-recovered.png") });
  results.push({ recoverableError: true, reducedMotion: true });
  await page.close();
  await writeFile(path.join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(JSON.stringify({ passed: true, artifacts: output, results }, null, 2));
} finally {
  await browser.close();
}
