import { expect, test, type Route } from "@playwright/test";

// The shopper agent is mocked (no API key or quota used): these tests cover the client flow, not the model.
const base = { store_id: "demo-store", prefs: { verbosity: "concise", speech_rate: 1 }, candidate_product_ids: [], step_index: 0 };

test("agent flow: choose a variant → position → guided steps", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route("**/api/agent/shopper", async (route: Route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    bodies.push(body);
    const turn = bodies.length;
    const reply =
      turn === 1
        ? { say: "I found two. Which one?", agent_text: "I found two. Which one?", route_text: [], choices: ["Silk Unsweetened Almond Milk", "Califia Almond Milk"], nav: { ...base, state: "SEARCHING", position_confidence: "UNKNOWN" } }
        : turn === 2
          ? { say: "Got it. Tap Scan so I can find you.", agent_text: "Got it. Tap Scan so I can find you.", route_text: [], choices: [], nav: { ...base, state: "DESTINATION_SELECTED", product_id: "P06", position_confidence: "UNKNOWN" } }
          : { say: "Walk forward to the main corridor.", agent_text: "Starting directions.", route_text: ["Walk forward to the main corridor."], choices: [], nav: { ...base, state: "GUIDING", product_id: "P06", current_node_id: "N01", position_confidence: "LIKELY" } };
    await route.fulfill({ json: { ...reply, ui_state: reply.nav.state, history: Array(turn).fill("h") } });
  });

  await page.goto("/shopper/guide");
  await page.getByLabel("Or type a reply").fill("I need almond milk");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("I found two. Which one?").first()).toBeVisible();
  await page.getByRole("button", { name: "Silk Unsweetened Almond Milk" }).click();

  await expect(page.getByRole("heading", { level: 1, name: "Product chosen" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Find my position" })).toBeVisible();
  // History round-trips: the second turn sends back what the first returned.
  expect(bodies[1].history).toEqual(["h"]);
  expect(bodies[1].utterance).toBe("Silk Unsweetened Almond Milk");

  await page.getByRole("button", { name: "I'm at the store entrance" }).click();
  await expect(page.getByText("Walk forward to the main corridor.").first()).toBeVisible();
  expect((bodies[2].scan as { selected_node_id: string; confidence_state: string }).selected_node_id).toBe("N01");
  expect((bodies[2].scan as { confidence_state: string }).confidence_state).toBe("LIKELY");
  for (const name of ["Previous", "Repeat", "Next"]) await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Find my position" })).toHaveCount(0);
});

test("agent offline (503) falls back to plain search", async ({ page }) => {
  await page.route("**/api/agent/shopper", (route) =>
    route.fulfill({ status: 503, json: { error: "AGENT_UNAVAILABLE", say: "The voice assistant is offline." } }),
  );
  await page.goto("/shopper/guide");
  await page.getByLabel("Or type a reply").fill("oat milk");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page).toHaveURL(/\/shopper\/(results|destination)$/);
});

test("a reply that arrives after New search is dropped", async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/agent/shopper", async (route) => {
    await gate;
    await route.fulfill({
      json: { say: "Late reply.", agent_text: "Late reply.", route_text: [], choices: ["Stale choice"], ui_state: "SEARCHING", nav: { ...base, state: "SEARCHING" }, history: ["h"] },
    });
  });
  await page.goto("/shopper/guide");
  await page.getByLabel("Or type a reply").fill("eggs");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Thinking…")).toBeVisible();
  await page.getByRole("button", { name: "‹ New search" }).click();
  await expect(page).toHaveURL(/\/shopper$/);
  const replied = page.waitForResponse("**/api/agent/shopper");
  release();
  await replied;
  await page.waitForTimeout(300);
  // The shell's live region persists across client navigation: the late reply must not be announced.
  await expect(page.getByRole("status").filter({ hasText: "Late reply." })).toHaveCount(0);
});
