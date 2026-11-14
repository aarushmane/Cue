import { describe, expect, it } from "vitest";
import { astar, buildGraph } from "@/lib/routing/astar";
import { classifyTurn } from "@/lib/routing/instructions";
import { planRoute } from "@/lib/routing/plan";
import * as seed from "@/lib/seed/demo-store";
import type { PublishedProduct, StoreGraph } from "@/lib/types";

function demoGraph(overrides: Partial<StoreGraph> = {}): StoreGraph {
  return {
    storeId: seed.DEMO_STORE.id, mapId: seed.DEMO_MAP.id, mapVersion: 1,
    widthM: seed.DEMO_STORE.widthM, heightM: seed.DEMO_STORE.heightM,
    nodes: seed.DEMO_NODES, edges: seed.DEMO_EDGES, shelves: seed.DEMO_SHELVES, ...overrides,
  };
}

function product(id: string, shelfOverride?: string): PublishedProduct {
  const p = seed.DEMO_PRODUCTS.find((x) => x.id === id)!;
  const loc = seed.DEMO_LOCATIONS.find((l) => l.productId === id)!;
  const shelfId = shelfOverride ?? loc.shelfId;
  const sh = seed.DEMO_SHELVES.find((s) => s.id === shelfId)!;
  return { ...p, location: { ...loc, shelfId }, shelf: { id: sh.id, aisle: sh.aisle, section: sh.section } };
}

const withoutEdges = (...pairs: [string, string][]) =>
  seed.DEMO_EDGES.filter((e) => !pairs.some(([a, b]) => (e.from === a && e.to === b) || (e.from === b && e.to === a)));

// Segment / axis-aligned rectangle intersection (Liang–Barsky clip).
function segmentHitsRect(ax: number, ay: number, bx: number, by: number, r: { x: number; y: number; w: number; h: number }) {
  let t0 = 0, t1 = 1;
  const dx = bx - ax, dy = by - ay;
  const p = [-dx, dx, -dy, dy];
  const q = [ax - r.x, r.x + r.w - ax, ay - r.y, r.y + r.h - ay];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; continue; }
    const t = q[i] / p[i];
    if (p[i] < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

describe("seed map integrity", () => {
  it("has 4 aisles / 12 shelf sections and 20+ products", () => {
    expect(new Set(seed.DEMO_SHELVES.map((s) => s.aisle)).size).toBe(4);
    expect(seed.DEMO_SHELVES).toHaveLength(12);
    expect(seed.DEMO_PRODUCTS.length).toBeGreaterThanOrEqual(20);
  });

  it("every shelf anchor is reachable from the entrance", () => {
    const g = buildGraph(seed.DEMO_NODES, seed.DEMO_EDGES, 30, 20);
    for (const s of seed.DEMO_SHELVES) expect(astar(g, "N01", s.anchorNodeId), s.id).not.toBeNull();
  });

  it("no walkable edge passes through a shelf (R01 geometry)", () => {
    const byId = new Map(seed.DEMO_NODES.map((n) => [n.id, n]));
    for (const e of seed.DEMO_EDGES) {
      const a = byId.get(e.from)!, b = byId.get(e.to)!;
      for (const s of seed.DEMO_SHELVES) expect(segmentHitsRect(a.x, a.y, b.x, b.y, s), `${e.id} × ${s.id}`).toBe(false);
    }
  });

  it("every product location references a real shelf", () => {
    const ids = new Set(seed.DEMO_SHELVES.map((s) => s.id));
    for (const l of seed.DEMO_LOCATIONS) expect(ids.has(l.shelfId), l.productId).toBe(true);
  });
});

describe("planRoute", () => {
  it("routes from the entrance to almond milk (Aisle 2, section 1)", () => {
    const r = planRoute(demoGraph(), "N01", product("P06"));
    expect(r.status).toBe("OK");
    if (r.status !== "OK") return;
    expect(r.path).toEqual(["N01", "N02", "N03", "N12"]);
    expect(r.destinationShelfId).toBe("S-A2-1");
    expect(r.steps.map((s) => s.text)).toEqual([
      "Head toward the front of the walkway between Aisles 2 and 3, about 13 meters.",
      "Turn left and continue to section 1 of the walkway between Aisles 2 and 3, about 3 meters.",
      "You have reached Aisle 2, section 1. Unsweetened Almond Milk should be on your left, on the middle shelf.",
    ]);
  });

  it("different start nodes produce different correct routes (R01)", () => {
    const fromEntrance = planRoute(demoGraph(), "N01", product("P06"));
    const fromHelpDesk = planRoute(demoGraph(), "N05", product("P06"));
    const fromBack = planRoute(demoGraph(), "N08", product("P06"));
    expect(fromHelpDesk.status === "OK" && fromHelpDesk.path).toEqual(["N05", "N04", "N03", "N12"]);
    expect(fromBack.status === "OK" && fromBack.path).toEqual(["N08", "N07", "N14", "N13", "N12"]);
    expect(fromEntrance.status === "OK" && fromEntrance.path).not.toEqual(fromHelpDesk.status === "OK" && fromHelpDesk.path);
  });

  it("states turns relative to the direction already walked", () => {
    const r = planRoute(demoGraph(), "N05", product("P06"));
    if (r.status !== "OK") throw new Error(r.status);
    // Walking west along the front corridor, then north into the walkway: that's a right turn.
    expect(r.steps[1].text).toMatch(/^Turn right/);
    // Heading north at N12, Aisle 2 (west) is on the left.
    expect(r.steps.at(-1)!.text).toContain("on your left");
  });

  it("uses a stored facing direction for the first instruction", () => {
    const nodes = seed.DEMO_NODES.map((n) => (n.id === "N01" ? { ...n, facingDeg: 0 } : n)); // facing up the plan
    const r = planRoute(demoGraph({ nodes }), "N01", product("P06"));
    if (r.status !== "OK") throw new Error(r.status);
    expect(r.steps[0].text).toMatch(/^Turn right, then walk to/);
  });

  it("reroutes when an edge is removed and fails cleanly when disconnected (R02)", () => {
    const rerouted = planRoute(demoGraph({ edges: withoutEdges(["N03", "N12"]) }), "N01", product("P06"));
    expect(rerouted.status).toBe("OK");
    if (rerouted.status === "OK") expect(rerouted.path.at(-2)).toBe("N13");

    const cut = planRoute(demoGraph({ edges: withoutEdges(["N03", "N12"], ["N12", "N13"]) }), "N01", product("P06"));
    expect(cut.status).toBe("ROUTE_UNAVAILABLE");
  });

  it("targets the new shelf after a product is moved (dynamic update)", () => {
    const before = planRoute(demoGraph(), "N01", product("P06"));
    const after = planRoute(demoGraph(), "N01", product("P06", "S-A4-3"));
    expect(before.status === "OK" && before.destinationShelfId).toBe("S-A2-1");
    expect(after.status === "OK" && after.destinationShelfId).toBe("S-A4-3");
    expect(after.status === "OK" && after.path.at(-1)).toBe("N17");
    // Aisle 4 sits east of walkway 3, so heading north it is on the right.
    expect(after.status === "OK" && after.steps.at(-1)!.text).toContain("on your right");
  });

  it("rejects unpublished products and unknown start nodes", () => {
    expect(planRoute(demoGraph(), "N01", null).status).toBe("PRODUCT_NOT_PUBLISHED");
    expect(planRoute(demoGraph(), "N99", product("P06")).status).toBe("START_NODE_INVALID");
    expect(planRoute(demoGraph(), "N01", { ...product("P06"), storeId: "other-store" }).status).toBe("PRODUCT_NOT_PUBLISHED");
  });

  it("reports ALREADY_THERE when starting at the shelf anchor", () => {
    const r = planRoute(demoGraph(), "N12", product("P06"));
    expect(r.status).toBe("ALREADY_THERE");
  });
});

describe("classifyTurn", () => {
  it("buckets angles", () => {
    expect(classifyTurn(5)).toBe("straight");
    expect(classifyTurn(40)).toBe("slight_right");
    expect(classifyTurn(-90)).toBe("left");
    expect(classifyTurn(170)).toBe("around");
  });
});
