import { describe, expect, it } from "vitest";
import { decidePosition } from "@/lib/vision/matchLandmark";
import * as seed from "@/lib/seed/demo-store";
import type { StoreGraph } from "@/lib/types";

const graph: StoreGraph = {
  storeId: seed.DEMO_STORE.id, mapId: seed.DEMO_MAP.id, mapVersion: 1, widthM: 30, heightM: 20,
  nodes: seed.DEMO_NODES, edges: seed.DEMO_EDGES, shelves: seed.DEMO_SHELVES,
};
const L = seed.DEMO_LANDMARKS;

describe("decidePosition (L01/L02)", () => {
  it("confirms a high-confidence match with no prior position", () => {
    const r = decidePosition({ landmark_id: "L03", confidence: "high", evidence: "AISLE 2 sign" }, L, graph, null);
    expect(r).toMatchObject({ confidence_state: "CONFIRMED", selected_node_id: "N03", landmark_id: "L03" });
  });

  it("downgrades a high-confidence match that is not adjacent to the previous position", () => {
    const r = decidePosition({ landmark_id: "L05", confidence: "high", evidence: "help desk" }, L, graph, "N01");
    expect(r.confidence_state).toBe("LIKELY");
  });

  it("treats medium confidence as LIKELY only when plausible from the previous position", () => {
    expect(decidePosition({ landmark_id: "L03", confidence: "medium", evidence: "" }, L, graph, "N02").confidence_state).toBe("LIKELY");
    expect(decidePosition({ landmark_id: "L05", confidence: "medium", evidence: "" }, L, graph, "N01").confidence_state).toBe("UNKNOWN");
  });

  it("never selects a node for low confidence, null or unknown ids", () => {
    for (const m of [
      { landmark_id: "L02", confidence: "low" as const, evidence: "" },
      { landmark_id: null, confidence: "high" as const, evidence: "" },
      { landmark_id: "L99", confidence: "high" as const, evidence: "" },
    ]) {
      const r = decidePosition(m, L, graph, null);
      expect(r.confidence_state).toBe("UNKNOWN");
      expect(r.selected_node_id).toBeNull();
    }
  });
});
