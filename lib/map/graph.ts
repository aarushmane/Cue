// Floor plan graph helpers shared by the map editor (client) and the map/review APIs (server).
// Editor previews use breadth-first search over drawn edges only. Shopper directions still come from
// lib/routing (A* over the published StoreGraph); these helpers never produce shopper guidance.
import { AISLE_NAMES, DEMO_LANDMARKS, DEMO_MAP, DEMO_NODES, DEMO_EDGES, DEMO_SHELVES, DEMO_STORE } from "../seed/demo-store";
import { shelfOf } from "../review/format";
import type { FloorPlan, MapNode, NodeKind, PublishedProduct, StoreGraph } from "../types";

export interface Check {
  ok: boolean;
  label: string;
  fix: string;
}

export const KIND_TXT: Record<string, string> = {
  entrance: "Entrance", service: "Help desk", junction: "Walk point", walk: "Walk point",
  shelf_approach: "Shelf approach point", aisle_marker: "Aisle marker", outdoor: "Outdoor approach point",
};

export const regionOf = (m: FloorPlan, shelfId: string) => m.shelves.find((s) => s.id === shelfId);

export function cloneMap(m: FloorPlan): FloorPlan {
  const { plan, ...rest } = m;
  return { ...(JSON.parse(JSON.stringify(rest)) as Omit<FloorPlan, "plan">), plan: plan ? { ...plan } : null };
}

function adjOf(m: FloorPlan): Record<string, string[]> {
  const adj: Record<string, string[]> = {};
  for (const [a, b] of m.edges) {
    (adj[a] ||= []).push(b);
    (adj[b] ||= []).push(a);
  }
  return adj;
}

/** BFS from every entrance over drawn edges. Returns the node path, or null when unreachable. */
export function routeTo(m: FloorPlan, target: string): string[] | null {
  const adj = adjOf(m);
  const prev: Record<string, string | null> = {};
  const q = m.nodes.filter((n) => n.kind === "entrance").map((n) => n.id);
  for (const id of q) prev[id] = null;
  while (q.length) {
    const c = q.shift()!;
    if (c === target) {
      const path: string[] = [];
      for (let x: string | null = c; x !== null && x !== undefined; x = prev[x]) path.unshift(x);
      return path;
    }
    for (const n of adj[c] || []) {
      if (!(n in prev)) {
        prev[n] = c;
        q.push(n);
      }
    }
  }
  return null;
}

/** Node ids reachable from any entrance. */
export function reachable(m: FloorPlan): Set<string> {
  const adj = adjOf(m);
  const seen = new Set(m.nodes.filter((n) => n.kind === "entrance").map((n) => n.id));
  const q = [...seen];
  while (q.length) {
    const c = q.shift()!;
    for (const n of adj[c] || []) {
      if (!seen.has(n)) {
        seen.add(n);
        q.push(n);
      }
    }
  }
  return seen;
}

/** Publish checklist for a floor plan draft. `products` are the verified products whose shelves must stay placed. */
export function mapChecks(m: FloorPlan, products: Pick<PublishedProduct, "location">[]): Check[] {
  const reach = reachable(m);
  const placed = m.shelves.filter((s) => s.id);
  const unassigned = m.shelves.length - placed.length;
  const ids = placed.map((s) => s.id);
  const dup = [...new Set(ids.filter((x, i) => ids.indexOf(x) !== i))];
  const has = (id: string) => m.nodes.some((n) => n.id === id);
  const noAnchor = placed.filter((s) => !s.anchor || !has(s.anchor)).map((s) => s.id);
  const unreach = placed.filter((s) => s.anchor && has(s.anchor) && !reach.has(s.anchor)).map((s) => s.id);
  const needed = [...new Set(products.map((p) => p.location.shelfId))].filter((id) => !ids.includes(id)).sort();
  const ent = m.nodes.some((n) => n.kind === "entrance");
  return [
    { ok: ent, label: "At least one entrance labeled", fix: "Use + Entrance and tap the entrance on the plan." },
    { ok: !unassigned, label: "Every shelf region has a shelf ID", fix: `${unassigned} shelf region${unassigned === 1 ? "" : "s"} without an ID.` },
    { ok: !dup.length, label: "Each shelf ID is placed once", fix: `Placed more than once: ${dup.join(", ")}.` },
    { ok: !noAnchor.length, label: "Every shelf has a walkable approach point", fix: `Missing: ${noAnchor.join(", ")}.` },
    { ok: ent && !unreach.length, label: "Every shelf is reachable from an entrance", fix: ent ? `No connected path to: ${unreach.join(", ")}.` : "Label an entrance first." },
    { ok: !needed.length, label: "Every shelf with verified products is placed", fix: `Place ${needed.join(", ")}, or those products would lose their location.` },
  ];
}

// ───────────────────────────── Conversions ─────────────────────────────

/** The seeded published map v1 in editor format (mirrors lib/seed/demo-store.ts). */
export function demoFloorPlan(): FloorPlan {
  return {
    mapId: DEMO_MAP.id,
    version: DEMO_MAP.version,
    plan: null,
    aspect: DEMO_STORE.widthM / DEMO_STORE.heightM,
    nodes: DEMO_NODES.map((n) => ({ id: n.id, x: n.x, y: n.y, kind: n.kind })),
    edges: DEMO_EDGES.map((e) => [e.from, e.to] as [string, string]),
    shelves: DEMO_SHELVES.map((s) => ({ key: s.id, id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, anchor: s.anchorNodeId })),
    landmarks: DEMO_LANDMARKS.map((l) => {
      const n = DEMO_NODES.find((x) => x.id === l.nodeId)!;
      return { id: l.id, x: n.x, y: n.y, label: l.description, verified: true };
    }),
  };
}

function nodeLabel(n: FloorPlan["nodes"][number], m: FloorPlan): string {
  const seeded = DEMO_NODES.find((x) => x.id === n.id && x.x === n.x && x.y === n.y);
  if (seeded) return seeded.label;
  if (n.kind === "entrance") return "the entrance";
  if (n.kind === "service") return "the help desk";
  const shelf = m.shelves.find((s) => s.anchor === n.id && s.id);
  const cat = shelf ? shelfOf(shelf.id) : undefined;
  return cat ? `the approach to Aisle ${cat.aisle}, Section ${cat.section} (${AISLE_NAMES[cat.aisle] ?? ""})` : `walk point ${n.id}`;
}

/**
 * Published editor map → StoreGraph consumed by lib/routing and /api/routes. Walk points become junctions.
 * `widthM` is the store's physical width (the plan's height follows from its aspect).
 */
export function toStoreGraph(m: FloorPlan, storeId: string, widthM: number = DEMO_STORE.widthM): StoreGraph {
  const W = widthM;
  const H = W / (m.aspect || 1.5);
  const nodes: MapNode[] = m.nodes.map((n) => ({
    id: n.id, x: n.x, y: n.y, kind: (n.kind === "walk" ? "junction" : n.kind) as NodeKind, label: nodeLabel(n, m),
  }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = m.edges
    .filter(([a, b]) => byId.has(a) && byId.has(b))
    .map(([a, b], i) => {
      const na = byId.get(a)!, nb = byId.get(b)!;
      return { id: `E${String(i + 1).padStart(2, "0")}`, from: a, to: b, weight: Math.round(Math.hypot((na.x - nb.x) * W, (na.y - nb.y) * H) * 10) / 10 };
    });
  const shelves = m.shelves.flatMap((r) => {
    const cat = shelfOf(r.id);
    return cat && r.anchor ? [{ id: r.id, aisle: cat.aisle, section: cat.section, anchorNodeId: r.anchor, x: r.x, y: r.y, w: r.w, h: r.h }] : [];
  });
  return { storeId, mapId: m.mapId, mapVersion: m.version, widthM: W, heightM: H, nodes, edges, shelves };
}
