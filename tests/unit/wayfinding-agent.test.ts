// Runs the real wayfinding deep agent graph with a scripted chat model (no network) and checks that the tools
// call the deterministic planner and that the returned plan is the planner's, not text from the model.
import { describe, expect, it } from "vitest";
import { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import { runWayfinding } from "@/lib/agents/wayfinding/agent";
import { v3 } from "@/lib/wayfinding/geometry";
import type { WayfindingScene } from "@/lib/wayfinding/types";

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

const wp = (id: string, x: number, y: number, neighbors: string[]) => ({
  id, position: v3(x, y, 0), camera: v3(x, y, 1.35), rotation: { x: 0, y: 0, z: 0, w: 1 }, floorId: "f1", neighbors,
});
const scene = (): WayfindingScene => ({
  modelId: "test",
  waypoints: [wp("a", 0, 0, ["b"]), wp("b", 3, 0, ["a", "c"]), wp("c", 3, 3, ["b"])],
  items: [{ id: "chips", name: "Potato chips", category: "snacks", position: v3(4, 3.5, 1), source: "staff" }],
  obstacles: [{ kind: "box", minX: 1, minY: 1, maxX: 2, maxY: 2 }],
});

describe("wayfinding deep agent", () => {
  it("finds the item, plans with the deterministic planner and returns that plan", { timeout: 20_000 }, async () => {
    const model = new ScriptedChat([
      new AIMessage({ content: "", tool_calls: [{ id: "t1", name: "find_item", args: { query: "where are the chips" } }] }),
      new AIMessage({ content: "", tool_calls: [{ id: "t2", name: "plan_route", args: { item_id: "chips" } }] }),
      new AIMessage("Head this way for about 3 meters."),
    ]);
    const out = await runWayfinding(scene(), { query: "where are the chips", start: { sweepId: "a" } }, { model });
    expect(out.tool_calls).toEqual(["find_item", "plan_route"]);
    expect(out.item?.id).toBe("chips");
    expect(out.plan?.status).toBe("OK");
    if (out.plan?.status === "OK") {
      expect(out.plan.waypointIds).toEqual(["a", "b", "c"]);
      expect(out.plan.arrows.length).toBeGreaterThan(3);
    }
    expect(out.reply).toBe("Head this way for about 3 meters.");
  });

  it("locates an unmapped item from detections before planning", { timeout: 20_000 }, async () => {
    // Soda at (0, 3, 1): seen from a (looking +y) and from c (looking −x).
    const elev = (dz: number, d: number) => (Math.atan2(dz, d) * 180) / Math.PI;
    const model = new ScriptedChat([
      new AIMessage({ content: "", tool_calls: [{ id: "t1", name: "find_item", args: { query: "soda" } }] }),
      new AIMessage({ content: "", tool_calls: [{ id: "t2", name: "locate_item", args: { label: "soda" } }] }),
      new AIMessage({ content: "", tool_calls: [{ id: "t3", name: "plan_route", args: { item_id: "vision-2" } }] }),
      new AIMessage("Done."),
    ]);
    const out = await runWayfinding(scene(), {
      query: "soda", start: { sweepId: "b" },
      detections: [{ label: "soda", detections: [
        { sweepId: "a", headingDeg: 90, elevationDeg: elev(-0.35, 3) },
        { sweepId: "c", headingDeg: 180, elevationDeg: elev(-0.35, 3) },
      ] }],
    }, { model });
    expect(out.tool_calls).toEqual(["find_item", "locate_item", "plan_route"]);
    expect(out.item).toMatchObject({ id: "vision-2", source: "vision" });
    expect(out.item!.position.x).toBeCloseTo(0, 1);
    expect(out.item!.position.y).toBeCloseTo(3, 1);
    expect(out.plan?.status === "OK" || out.plan?.status === "ALREADY_THERE").toBe(true);
  });
});
