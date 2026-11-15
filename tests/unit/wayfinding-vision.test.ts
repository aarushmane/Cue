import { describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { runWayfinding } from "@/lib/agents/wayfinding/agent";
import { headingDeg, v3 } from "@/lib/wayfinding/geometry";
import { locateFromDetections } from "@/lib/wayfinding/locate";
import { parseObj, raycast } from "@/lib/wayfinding/mesh";
import type { Waypoint } from "@/lib/wayfinding/types";

// A shelf face: the plane y = 4.5 between x 2..10, z 0..2 (two triangles), plus a wall at x = 12.
const OBJ = `
v 2 4.5 0
v 10 4.5 0
v 10 4.5 2
v 2 4.5 2
v 12 0 0
v 12 8 0
v 12 8 3
v 12 0 3
f 1 2 3
f 1 3 4
f 5/1 6/2 7/3 8/4
`;
const surfaces = parseObj(OBJ);
const wp = (id: string, x: number, y: number): Waypoint => ({ id, position: v3(x, y, 0), camera: v3(x, y, 1.35), rotation: { x: 0, y: 0, z: 0, w: 1 }, floorId: "f1", neighbors: [] });
const sweeps = [wp("a", 4, 6), wp("b", 7, 6), wp("c", 9, 7)];
/** A detection aimed exactly at `target` from sweep `w`. */
const aim = (w: Waypoint, target: ReturnType<typeof v3>, confidence = 1) => {
  const c = w.camera!;
  return { sweepId: w.id, headingDeg: headingDeg(c, target), elevationDeg: (Math.atan2(target.z - c.z, Math.hypot(target.x - c.x, target.y - c.y)) * 180) / Math.PI, confidence };
};

describe("scan mesh", () => {
  it("parses OBJ faces (fanning quads, ignoring texture indices)", () => {
    expect(surfaces.length).toBe(4 * 9); // 2 triangles + 1 quad → 4 triangles
  });
  it("casts a ray onto the nearest surface", () => {
    expect(raycast(surfaces, { origin: v3(6, 6, 1), dir: v3(0, -1, 0) })).toBeCloseTo(1.5);
    expect(raycast(surfaces, { origin: v3(6, 6, 1), dir: v3(1, 0, 0) })).toBeCloseTo(6);
    expect(raycast(surfaces, { origin: v3(6, 6, 1), dir: v3(0, 1, 0) })).toBeNull();
  });
});

describe("locating from photo detections on the mesh", () => {
  const chips = v3(6.5, 4.5, 1.1);
  it("places a single detection on the surface it points at", () => {
    const r = locateFromDetections(sweeps, [aim(sweeps[1], chips)], [], surfaces);
    expect(r).toMatchObject({ status: "OK", method: "surface", support: { sweeps: 1 } });
    if (r.status === "OK") { expect(r.position.x).toBeCloseTo(6.5, 1); expect(r.position.y).toBeCloseTo(4.5, 1); }
  });
  it("lets photos that agree outvote a false positive", () => {
    const decoy = v3(12, 7, 1.5); // something on the wall, seen confidently from one sweep
    const r = locateFromDetections(sweeps, [aim(sweeps[0], chips, 0.7), aim(sweeps[1], chips, 0.7), aim(sweeps[2], decoy, 1)], [], surfaces);
    expect(r.status).toBe("OK");
    if (r.status !== "OK") return;
    expect(r.support).toEqual({ detections: 2, sweeps: 2 });
    expect(r.position.x).toBeCloseTo(6.5, 1);
    expect(r.confidence).toBeGreaterThan(0.5);
  });
});

class ScriptedChat extends BaseChatModel {
  private i = 0;
  constructor(private script: AIMessage[]) { super({}); }
  _llmType() { return "scripted"; }
  bindTools() { return this as never; }
  async _generate(): Promise<ChatResult> {
    const message = this.script[Math.min(this.i++, this.script.length - 1)];
    return { generations: [{ text: typeof message.content === "string" ? message.content : "", message }] };
  }
}

describe("agent photo search", () => {
  it("searches the photos when the item is not mapped, then routes to it", { timeout: 20_000 }, async () => {
    const scene = {
      modelId: "test", items: [], obstacles: [],
      waypoints: [{ ...wp("a", 4, 6), neighbors: ["b"] }, { ...wp("b", 7, 6), neighbors: ["a"] }],
    };
    const searched: string[] = [];
    const model = new ScriptedChat([
      new AIMessage({ content: "", tool_calls: [{ id: "t1", name: "find_item", args: { query: "chips" } }] }),
      new AIMessage({ content: "", tool_calls: [{ id: "t2", name: "locate_item", args: { label: "chips" } }] }),
      new AIMessage({ content: "", tool_calls: [{ id: "t3", name: "plan_route", args: { item_id: "vision:chips" } }] }),
      new AIMessage("Done."),
    ]);
    const out = await runWayfinding(scene, {
      query: "chips", start: { sweepId: "a" },
      searchPhotos: async (q) => {
        searched.push(q);
        return { status: "OK", detections: 3, items: [
          { id: "vision:chips:0", name: "Chips", position: v3(-6, 9, 1), source: "vision", confidence: 0.9 }, // far away
          { id: "vision:chips", name: "Chips", position: v3(6.8, 4.5, 1), source: "vision", confidence: 0.8 }, // nearer
        ] };
      },
    }, { model });
    expect(searched).toEqual(["chips"]);
    expect(out.item?.id).toBe("vision:chips"); // the nearest place, not the first listed
    expect(out.tool_calls).toEqual(["find_item", "locate_item", "plan_route"]);
    expect(out.plan?.status).toBe("OK");
    if (out.plan?.status === "OK") expect(out.plan.waypointIds.at(-1)).toBe("b");
  });
});

describe("product catalogue matching", () => {
  it("matches brands and products, leaving categories to the photo search", async () => {
    const { matchCatalog } = await import("@/lib/wayfinding/catalogMatch");
    const at = { x: 0, y: 0, z: 1 };
    const items = [
      { id: "c1", name: "Doritos", brand: "Doritos", aliases: ["Nacho Cheese"], category: "chips", position: at, source: "vision" as const },
      { id: "c2", name: "Doritos", brand: "Doritos", aliases: ["Cool Ranch"], category: "chips", position: at, source: "vision" as const },
      { id: "c3", name: "Cheetos", brand: "Cheetos", aliases: ["Cheetos Puffs"], category: "chips", position: at, source: "vision" as const },
      { id: "c4", name: "Cheetos", brand: "Cheetos", aliases: ["Flamin' Hot Cheetos"], category: "chips", position: at, source: "vision" as const },
      { id: "c5", name: "M&M's", brand: "M&M's", aliases: ["Peanut"], category: "candy", position: at, source: "vision" as const },
    ];
    expect(matchCatalog(items, "where are the doritos").map((i) => i.id)).toEqual(["c1", "c2"]); // every place, nearest picked later
    expect(matchCatalog(items, "hot cheetos").map((i) => i.id)).toEqual(["c4"]); // product beats brand
    expect(matchCatalog(items, "cheetos").map((i) => i.id)).toEqual(["c3", "c4"]);
    expect(matchCatalog(items, "m&ms").map((i) => i.id)).toEqual(["c5"]);
    expect(matchCatalog(items, "chips")).toEqual([]); // category: photo search handles it
    expect(matchCatalog(items, "takis")).toEqual([]);
  });
});

describe("category questions and model quota", () => {
  it("answers whole categories from the catalogue", async () => {
    const { matchCategory } = await import("@/lib/wayfinding/catalogMatch");
    const at = { x: 0, y: 0, z: 1 };
    const items = [
      { id: "a", name: "Doritos", category: "chips", position: at, source: "vision" as const },
      { id: "b", name: "Snickers", category: "chocolate", position: at, source: "vision" as const },
      { id: "c", name: "Skittles", category: "candy", position: at, source: "vision" as const },
      { id: "d", name: "Coca-Cola", category: "soda", position: at, source: "vision" as const },
    ];
    expect(matchCategory(items, "where is the candy").map((i) => i.id)).toEqual(["b", "c"]);
    expect(matchCategory(items, "chips").map((i) => i.id)).toEqual(["a"]);
    expect(matchCategory(items, "something to drink").map((i) => i.id)).toEqual(["d"]);
    expect(matchCategory(items, "batteries")).toEqual([]);
    const cakes = [...items, { id: "e", name: "Hostess", category: "snack cakes", position: at, source: "vision" as const }];
    expect(matchCategory(cakes, "snack cakes").map((i) => i.id)).toEqual(["e"]); // exact category beats "snack" → chips
    const sweets = [...items, { id: "f", name: "M&M's", category: "chocolate", position: at, source: "vision" as const }];
    expect(matchCategory(sweets, "soda").map((i) => i.id)).toEqual(["d"]); // "chocolate" is not "cola"
    expect(matchCategory(items, "potato chips").map((i) => i.id)).toEqual(["a"]); // "chips" inside "potato chips"
  });

  it("recognises quota errors and moves to the next model until the limit resets", async () => {
    const { geminiModels, isQuotaError, markExhausted } = await import("@/lib/ai/gemini");
    const quota = new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"retryDelay":"20791s"}]}}');
    expect(isQuotaError(quota)).toBe(true);
    expect(isQuotaError(new Error("Request contains an invalid argument."))).toBe(false);
    const [first, second] = geminiModels("model-a");
    expect(first).toBe("model-a");
    markExhausted("model-a", quota);
    expect(geminiModels("model-a")[0]).toBe(second);
  });
});
