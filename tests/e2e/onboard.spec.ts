import { expect, test, type Page } from "@playwright/test";
import { resetDemo } from "./helpers";

// The onboarding screen with the agent stream mocked (no AI call): confirm step, live plan, result, and opening the
// imported graph in the floor plan editor (issue #4, 2E and 2F).
const result = {
  run_id: "run-e2e", source: "fixture", draft_id: "draft-e2e", report: "Imported **3** points.", todos: [{ content: "Look up the property", status: "completed" }],
  tool_calls: ["write_todos", "lookup_property"], graph_summary: { nodes: 3, edges: 2, components: 1, warnings: [] },
  candidates_queued: 1, review_observation_ids: ["OBS-900"], store_id: "demo-store", log: [],
  view: {
    property: { id: "fixture-property-1", name: "Fixture Market", address: "1 Test St", property_type: null, matterport_model_id: null },
    graph: {
      floor_id: "f0", floor_label: "Ground floor", width_m: 30, height_m: 20, edge_source: "neighbors",
      nodes: [
        { id: "sweep-a", x: 0.1, y: 0.9, kind: "entrance", label: "Entrance", landmark: true },
        { id: "sweep-b", x: 0.5, y: 0.5, kind: "junction", label: "", landmark: false },
        { id: "sweep-c", x: 0.9, y: 0.1, kind: "junction", label: "", landmark: false },
      ],
      edges: [["sweep-a", "sweep-b"], ["sweep-b", "sweep-c"]], plan: null,
    },
    candidates: [{ name: "Oat Milk", brand: "Califia", confidence: "high", image_url: "" }], aerial: null,
  },
};

test.beforeEach(async ({ page }) => resetDemo(page));

/** Open the confirm dialog (retried: a click that lands before hydration does nothing). */
async function openConfirm(page: Page) {
  await expect(async () => {
    await page.getByRole("button", { name: "Run onboarding agent" }).click();
    await expect(page.getByRole("alertdialog", { name: "Run the onboarding agent?" })).toBeVisible({ timeout: 1000 });
  }).toPass();
  return page.getByRole("alertdialog", { name: "Run the onboarding agent?" });
}

test("confirm, run, then open the imported draft in the floor plan editor", async ({ page }) => {
  let calls = 0;
  let body: Record<string, unknown> = {};
  await page.route("**/api/agent/onboard/stream", async (route) => {
    calls++;
    body = route.request().postDataJSON();
    const sse = [{ type: "todos", todos: [{ content: "Look up the property", status: "in_progress" }] }, { type: "result", result }]
      .map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
    await route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: sse });
  });

  await page.goto("/business/onboard");
  await page.getByRole("textbox", { name: "Which store is this for?" }).fill("demo-store");
  const dialog = await openConfirm(page);
  await expect(dialog).toContainText("about 10 AI requests");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(calls).toBe(0);

  await (await openConfirm(page)).getByRole("button", { name: "Run agent" }).click();
  await expect(page.getByText("Done. Draft draft-e2e from fixture data.")).toBeVisible();
  expect(calls).toBe(1);
  expect(body).toMatchObject({ costar_property_id: "fixture-property-1", store_id: "demo-store" });
  await expect(page.getByText("1 suggestion is waiting in demo-store's Review queue")).toBeVisible();
  await expect(page.getByText("No shelves were imported.")).toBeVisible();

  await page.getByRole("button", { name: "Edit this draft in the floor plan editor" }).click();
  await expect(page).toHaveURL(/\/business\/floor-plan$/);
  await expect(page.getByText("Editing draft · based on published v1")).toBeVisible();
  // The publish checklist still gates it: verified products' shelves aren't placed on the imported draft.
  await expect(page.getByText("Every shelf with verified products is placed")).toBeVisible();
});

test("a passcode refusal reveals the passcode field", async ({ page }) => {
  await page.route("**/api/agent/onboard/stream", (route) =>
    route.fulfill({ status: 401, json: { ok: false, status: 401, code: "PASSCODE", error: "Enter the onboarding passcode to run the agent." } }));
  await page.goto("/business/onboard");
  await expect(page.getByLabel("Onboarding passcode")).toHaveCount(0);
  await (await openConfirm(page)).getByRole("button", { name: "Run agent" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Enter the onboarding passcode" })).toBeVisible();
  await expect(page.getByLabel("Onboarding passcode")).toBeFocused();
});
