import { expect, test, type Page } from "@playwright/test";

// Fake Web Speech recognition + a log of speech-output calls, so phone rules can be checked in desktop Chromium.
type Log = { ev: string; text?: string; volume?: number }[];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __log: Log; __rec: unknown; SpeechRecognition: unknown; webkitSpeechRecognition: unknown };
    type Log = { ev: string; text?: string; volume?: number }[];
    w.__log = [];
    const ss = window.speechSynthesis;
    ss.speak = (u: SpeechSynthesisUtterance) => void w.__log.push({ ev: "speak", text: u.text, volume: u.volume });
    ss.cancel = () => void w.__log.push({ ev: "cancel" });
    class FakeRec {
      lang = ""; interimResults = false; maxAlternatives = 1;
      onspeechend: (() => void) | null = null;
      onresult: ((e: unknown) => void) | null = null;
      onerror: ((e: { error: string }) => void) | null = null;
      onend: (() => void) | null = null;
      start() { w.__log.push({ ev: "rec.start" }); w.__rec = this; }
      stop() { w.__log.push({ ev: "rec.stop" }); }
      abort() { w.__log.push({ ev: "rec.abort" }); }
    }
    w.SpeechRecognition = FakeRec;
    w.webkitSpeechRecognition = FakeRec;
  });
});

const log = (page: Page) => page.evaluate(() => (window as unknown as { __log: Log }).__log);
const rec = (page: Page, fn: string, arg?: unknown) =>
  page.evaluate(([f, a]) => {
    const r = (window as unknown as { __rec: Record<string, (x?: unknown) => void> }).__rec;
    r[f as string]?.(a);
  }, [fn, arg] as const);
const mic = (page: Page) => page.locator(`button[aria-describedby="mic-status"]`); // its label changes with state

test("the first tap unlocks speech with a silent utterance (iOS)", async ({ page }) => {
  await page.goto("/shopper");
  await page.getByRole("button", { name: "Hear Instructions" }).click();
  const l = await log(page);
  const firstSpeak = l.find((x) => x.ev === "speak")!;
  expect(firstSpeak.volume).toBe(0);
  expect(firstSpeak.text?.trim()).toBe("");
  expect(l.filter((x) => x.ev === "speak" && x.volume === 0)).toHaveLength(1); // only once
});

test("speech is cancelled before listening and never starts while listening (no echo)", async ({ page }) => {
  await page.goto("/shopper");
  await mic(page).click();
  const l = await log(page);
  const start = l.findIndex((x) => x.ev === "rec.start");
  expect(start).toBeGreaterThan(-1);
  expect(l.slice(0, start).some((x) => x.ev === "cancel")).toBe(true);

  // Something tries to talk while the mic is open: the live region updates, speech output stays off.
  const before = (await log(page)).length;
  await page.getByRole("button", { name: "Hear Instructions" }).click();
  expect((await log(page)).slice(before).some((x) => x.ev === "speak" && (x.volume ?? 1) > 0)).toBe(false);
  await expect(page.getByRole("status").filter({ hasText: "To search, tap Speak" })).toBeAttached();
});

test("a recognized request goes to the agent and the reply is spoken", async ({ page }) => {
  await page.route("**/api/agent/shopper", (route) =>
    route.fulfill({
      json: {
        say: "Which almond milk?", agent_text: "Which almond milk?", route_text: [], choices: ["Silk", "Blue Diamond"], ui_state: "SEARCHING",
        nav: { store_id: "demo-store", state: "SEARCHING", prefs: { verbosity: "concise", speech_rate: 1 } }, history: [],
      },
    }),
  );
  await page.goto("/shopper");
  await mic(page).click();
  await rec(page, "onresult", { results: { 0: { 0: { transcript: "I need almond milk" } } } });
  await rec(page, "onend");
  await expect(page).toHaveURL(/\/shopper\/guide$/);
  await expect.poll(async () => (await log(page)).some((x) => x.ev === "speak" && x.text === "Which almond milk?")).toBe(true);
});

test("iOS error codes show the right message", async ({ page }) => {
  await page.goto("/shopper");
  await mic(page).click();
  await rec(page, "onerror", { error: "service-not-allowed" });
  await expect(page.locator("#mic-status")).toContainText("turn on Dictation");

  await mic(page).click(); // try again → interrupted by the system (not by the shopper)
  await rec(page, "onerror", { error: "aborted" });
  await expect(page.locator("#mic-status")).toContainText("Listening was interrupted");
});

test("stopping listening yourself does not show an error", async ({ page }) => {
  await page.goto("/shopper");
  await mic(page).click();
  await page.getByRole("button", { name: /Listening/ }).click(); // tap to stop
  await rec(page, "onerror", { error: "aborted" });
  await rec(page, "onend");
  await expect(page.locator("#mic-status")).toHaveText("Stopped listening.");
});
