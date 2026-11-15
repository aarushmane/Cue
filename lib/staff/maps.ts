// Floor plans in Supabase (issue #6, 4D): reading a store's maps back in the editor's FloorPlan format, and the
// payload publish_map() materializes. See supabase/migrations/005_map_editor.sql for the storage model:
// - a DRAFT is the editor's FloorPlan in store_maps.plan_json (no node/shelf rows);
// - publishing writes nodes/edges/landmarks with ids "<map id>:<editor id>" and moves placed shelves onto the map.
// The pure helpers here are unit-tested; readStoreMaps needs the service-role client.
import type { SupabaseClient } from "@supabase/supabase-js";
import { toStoreGraph } from "../map/graph";
import type { FloorPlan, PlanNodeKind, StoreMaps } from "../types";

interface MapRow { id: string; version: number; plan_json: FloorPlan | null; saved_at: string | null; draft_rev: number }
interface NodeRow { id: string; x: number; y: number; kind: string }
interface EdgeRow { from_node: string; to_node: string }
interface ShelfRow { id: string; anchor_node: string; x: number; y: number; w: number; h: number }
interface LandmarkRow { id: string; node_id: string; description: string; verified: boolean | null }

/** Editor id for a materialized row: strips the "<map id>:" namespace publish_map adds (seeded rows have none). */
export const editorId = (mapId: string, id: string) => (id.startsWith(`${mapId}:`) ? id.slice(mapId.length + 1) : id);

/**
 * A published map that has no plan_json (the seed, or rows written before 005), rebuilt from its rows. The plan
 * background is null and the aspect comes from the store's size, as in memory mode's demoFloorPlan().
 */
export function tablesToFloorPlan(
  map: { id: string; version: number }, store: { width_m: number; height_m: number },
  rows: { nodes: NodeRow[]; edges: EdgeRow[]; shelves: ShelfRow[]; landmarks: LandmarkRow[] },
): FloorPlan {
  const eid = (id: string) => editorId(map.id, id);
  const at = new Map(rows.nodes.map((n) => [n.id, n]));
  return {
    mapId: map.id,
    version: map.version,
    plan: null,
    aspect: store.width_m / store.height_m,
    nodes: rows.nodes.map((n) => ({ id: eid(n.id), x: n.x, y: n.y, kind: n.kind as PlanNodeKind })),
    edges: rows.edges.map((e) => [eid(e.from_node), eid(e.to_node)] as [string, string]),
    shelves: rows.shelves.map((s) => ({ key: s.id, id: s.id, x: s.x, y: s.y, w: s.w, h: s.h, anchor: eid(s.anchor_node) })),
    landmarks: rows.landmarks.flatMap((l) => {
      const n = at.get(l.node_id);
      return n ? [{ id: eid(l.id), x: n.x, y: n.y, label: l.description, verified: l.verified ?? true }] : [];
    }),
  };
}

export interface GraphPayload {
  nodes: { id: string; x: number; y: number; kind: string; label: string }[];
  edges: { id: string; from: string; to: string; weight: number }[];
  shelves: { id: string; aisle: string; section: string; anchor: string; x: number; y: number; w: number; h: number }[];
  landmarks: { id: string; node: string; description: string }[];
  height_m: number;
}

/**
 * What publish_map() materializes for a draft: the same StoreGraph memory mode routes on (labels, junctions for walk
 * points, metric edge weights), plus VERIFIED landmarks attached to their nearest point (shoppers localize against
 * them; unverified ones stay in plan_json only). `unknownShelves` are placed shelf IDs the catalog doesn't know,
 * which toStoreGraph would drop: the caller refuses to publish them.
 */
export function graphPayload(draft: FloorPlan, storeId: string, widthM: number): { payload: GraphPayload; unknownShelves: string[] } {
  const g = toStoreGraph(draft, storeId, widthM);
  const kept = new Set(g.shelves.map((s) => s.id));
  const unknownShelves = draft.shelves.filter((s) => s.id && !kept.has(s.id)).map((s) => s.id);
  const landmarks = draft.landmarks.filter((l) => l.verified && g.nodes.length).map((l) => {
    let best = g.nodes[0], bestD = Infinity;
    for (const n of g.nodes) {
      const d = (n.x - l.x) ** 2 + (n.y - l.y) ** 2;
      if (d < bestD) [best, bestD] = [n, d];
    }
    return { id: l.id, node: best.id, description: l.label };
  });
  return {
    payload: {
      nodes: g.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y, kind: n.kind, label: n.label })),
      edges: g.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, weight: e.weight })),
      shelves: g.shelves.map((s) => ({ id: s.id, aisle: s.aisle, section: s.section, anchor: s.anchorNodeId, x: s.x, y: s.y, w: s.w, h: s.h })),
      landmarks,
      height_m: g.heightM,
    },
    unknownShelves,
  };
}

const must = <T>(r: { data: T | null; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
};

/** The store's published map and editor draft, in the editor's format (null if the store has no published map). */
export async function readStoreMaps(db: SupabaseClient, storeId: string): Promise<(StoreMaps & { draftRev: number | null }) | null> {
  const cols = "id, version, plan_json, saved_at, draft_rev";
  const [pubRes, draftRes, storeRes] = await Promise.all([
    db.from("store_maps").select(cols).eq("store_id", storeId).eq("status", "PUBLISHED").maybeSingle(),
    db.from("store_maps").select(cols).eq("store_id", storeId).eq("status", "DRAFT").not("plan_json", "is", null)
      .order("version", { ascending: false }).limit(1).maybeSingle(),
    db.from("stores").select("width_m, height_m").eq("id", storeId).maybeSingle(),
  ]);
  const pub = must(pubRes) as MapRow | null;
  const store = must(storeRes) as { width_m: number; height_m: number } | null;
  if (!pub || !store) return null;
  const draft = must(draftRes) as MapRow | null;

  let published: FloorPlan;
  if (pub.plan_json) {
    published = { ...pub.plan_json, mapId: pub.id, version: pub.version };
  } else {
    const [nodes, edges, shelves] = await Promise.all([
      db.from("nodes").select("id, x, y, kind").eq("map_id", pub.id),
      db.from("edges").select("from_node, to_node").eq("map_id", pub.id),
      db.from("shelves").select("id, anchor_node, x, y, w, h").eq("map_id", pub.id),
    ]);
    const nodeRows = must(nodes) as NodeRow[];
    const landmarks = nodeRows.length
      ? (must(await db.from("landmarks").select("id, node_id, description, verified").in("node_id", nodeRows.map((n) => n.id))) as LandmarkRow[])
      : [];
    published = tablesToFloorPlan(pub, store, { nodes: nodeRows, edges: must(edges) as EdgeRow[], shelves: must(shelves) as ShelfRow[], landmarks });
  }
  return {
    published,
    // Same convention as memory mode: the draft carries the published map's id and version.
    draft: draft?.plan_json ? { ...draft.plan_json, mapId: pub.id, version: pub.version } : null,
    draftSavedAt: draft?.saved_at ?? null,
    draftRev: draft?.draft_rev ?? null,
  };
}
