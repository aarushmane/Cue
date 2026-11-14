import { expect, test } from "@playwright/test";

// Fake camera: Chromium's synthetic device, permission auto-granted.
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

const base = { store_id: "demo-store", prefs: { verbosity: "concise", speech_rate: 1 }, candidate_product_ids: [], step_index: 0 };
const chosen = {
  say: "Tap Scan so I can find you.", agent_text: "Tap Scan so I can find you.", route_text: [], choices: [], ui_state: "DESTINATION_SELECTED",
  nav: { ...base, state: "DESTINATION_SELECTED", product_id: "P06", position_confidence: "UNKNOWN" }, history: ["h"],
};

test.beforeEach(async ({ page }) => {
  // Record every camera stream so the test can check its tracks were stopped.
  await page.addInitScript(() => {
    const w = window as unknown as { __streams: MediaStream[] };
    w.__streams = [];
    const orig = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await orig(c);
      w.__streams.push(s);
      return s;
    };
  });
  await page.route("**/api/agent/shopper", (route) => route.fulfill({ json: chosen }));
});

const liveTracks = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks()).filter((t) => t.readyState === "live").length);

test("leaving mid-scan stops the camera and uploads nothing", async ({ page }) => {
  let uploads = 0;
  await page.route("**/api/localize", (route) => {
    uploads++;
    return route.fulfill({ json: { confidence_state: "UNKNOWN", selected_node_id: null, candidate_node_ids: [], landmark_id: null, evidence: "" } });
  });
  await page.goto("/shopper/guide");
  await page.getByLabel("Or type a reply").fill("almond milk");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Scanning…" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __streams: MediaStream[] }).__streams.length)).toBe(1);
  await page.getByRole("button", { name: "‹ New search" }).click();
  await expect(page).toHaveURL(/\/shopper$/);
  await page.waitForTimeout(2500); // longer than a full scan (300 ms + 2 × 600 ms)
  expect(await liveTracks(page)).toBe(0);
  expect(uploads).toBe(0);
});

test("a completed scan stops the camera and sends 1–3 frames with consent-based sharing", async ({ page }) => {
  let body: { frames: string[]; share_sightings: boolean } | null = null;
  await page.route("**/api/localize", (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { confidence_state: "UNKNOWN", selected_node_id: null, candidate_node_ids: [], landmark_id: null, evidence: "no landmark" } });
  });
  await page.goto("/shopper/guide");
  await page.getByLabel("Or type a reply").fill("almond milk");
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect.poll(() => body !== null, { timeout: 10_000 }).toBe(true);
  expect(body!.frames.length).toBeGreaterThanOrEqual(1);
  expect(body!.frames.length).toBeLessThanOrEqual(3);
  expect(body!.share_sightings).toBe(false); // contributions not allowed on a fresh device
  expect(await liveTracks(page)).toBe(0);
});

test("entrance confirmation cannot submit a competing turn during capture", async ({ page }) => {
  let turns = 0;
  await page.route("**/api/agent/shopper", (route) => {
    turns++;
    return route.fulfill({ json: chosen });
  });
  await page.goto("/shopper/guide");
  await page.getByLabel("Or type a reply").fill("milk");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByRole("button", { name: "Scan", exact: true }).click();
  await expect(page.getByRole("button", { name: "Scanning…" })).toBeVisible();
  await page.getByRole("button", { name: "I'm at the store entrance" }).click({ force: true });
  expect(turns).toBe(1);
});
