// inspect_aerial must give the vision model the image but keep the image data URL out of everything else:
// the agent's tool result (model context), the run log (saved to agent_runs), and the screen's RunView (API response).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataLayers } from "@/lib/costar";

const analyzeAerial = vi.fn();
vi.mock("@/lib/vision/aerial", () => ({ analyzeAerial: (...a: unknown[]) => analyzeAerial(...a) }));
const aiConfigured = vi.fn(() => true);
vi.mock("@/lib/ai/provider", async (orig) => ({ ...(await orig<object>()), aiConfigured: () => aiConfigured() }));

const { newRun } = await import("@/lib/agents/onboarding/run-context");
const { onboardingTools } = await import("@/lib/agents/onboarding/tools");
const { runView } = await import("@/lib/agents/onboarding/view");

const IMAGE = `data:image/jpeg;base64,${"QUVSSUFMLVBJWEVMUw".repeat(50)}`;
const layers = {
  source: "costar",
  getAerial: async () => ({ imageDataUrl: IMAGE, capturedAt: null, extentM: 140, notes: "Vexcel orthophoto, north up, 140 m square." }),
} as unknown as DataLayers;

function runWithProperty() {
  const run = newRun("r1", layers);
  run.property = { id: "9560712", name: "Test Store", address: "1 Main St", latitude: 34.05, longitude: -118.25 } as NonNullable<typeof run.property>;
  return run;
}

async function inspect(run: ReturnType<typeof runWithProperty>) {
  const t = onboardingTools(run).main.find((x) => x.name === "inspect_aerial")!;
  return String(await t.invoke({}));
}

const leaks = (s: string) => s.includes(IMAGE) || /data:image|base64/.test(s);

describe("inspect_aerial keeps the aerial image server-side", () => {
  beforeEach(() => {
    analyzeAerial.mockReset();
    aiConfigured.mockReturnValue(true);
  });

  it("sends the image to the vision model only, and returns text everywhere else", async () => {
    analyzeAerial.mockResolvedValue({
      building_found: true, entrance_side: "south", parking: "surface lot to the west", approach_notes: "sidewalk on Main St, curb cut at the corner",
      evidence: "storefront glass on the south face", confidence: "medium",
    });
    const run = runWithProperty();
    const out = await inspect(run);

    expect(analyzeAerial).toHaveBeenCalledWith(IMAGE, expect.objectContaining({ name: "Test Store", extentM: 140 }));
    expect(leaks(out)).toBe(false); // tool result = model context
    expect(leaks(JSON.stringify(run.log))).toBe(false); // persisted run log
    const view = runView(run);
    expect(leaks(JSON.stringify(view))).toBe(false); // API / Server Function response
    expect(view.aerial?.notes).toMatch(/Entrance likely faces south \(medium\)/);
    expect(view.aerial?.notes).toMatch(/Parking: surface lot to the west/);
  });

  it("still gives the screen the Vexcel notes when no AI provider is configured", async () => {
    aiConfigured.mockReturnValue(false);
    const run = runWithProperty();
    const out = await inspect(run);
    expect(analyzeAerial).not.toHaveBeenCalled();
    expect(leaks(out)).toBe(false);
    expect(runView(run).aerial).toEqual({ notes: "Vexcel orthophoto, north up, 140 m square." });
  });
});
