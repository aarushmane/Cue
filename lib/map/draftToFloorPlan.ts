// Onboarding draft graph → floor plan editor draft (issue #4, 2F). Pure; safe on client and server.
//
// Frames. The onboarding GraphView is normalized to the walkable graph's bounding box (width_m × height_m), and its
// floor plan image is placed in that frame at plan.{x,y,w,h} (it can extend past 0..1). The editor's FloorPlan draws
// `plan.url` stretched over its whole 0..1 frame (FloorPlanViewer: background-size 100% 100%). So when there is a plan
// image, the editor frame must be the IMAGE's frame, not the graph's:
//   x' = (x - plan.x) / plan.w,  y' = (y - plan.y) / plan.h,  aspect = (plan.w · width_m) / (plan.h · height_m)
// Without an image the graph frame is used as is (aspect = width_m / height_m).
//
// What doesn't map (listed in `notes` so staff see it):
// - Node labels and Matterport sweep ids: the editor's nodes have no label (spoken names are derived on publish).
// - Shelves: the import has none. Staff draw shelf regions; mapChecks() blocks publishing until verified products'
//   shelves are placed and reachable.
// - Landmarks become unverified editor landmarks at their scan point, labeled with the node's label.
// - Points outside the floor plan image are clamped to its edge; "outdoor" points become walk points.
// - The plan URL comes from Matterport and may be a signed link that expires; re-upload the plan if it stops showing.
import type { GraphView } from "../agents/onboarding/view";
import type { FloorPlan, PlanNodeKind } from "../types";

export interface DraftConversion {
  plan: FloorPlan;
  notes: string[];
}

// Same limits the map routes validate (lib/demo/schemas.ts).
const MAX_NODES = 500;
const MAX_EDGES = 2000;
const MAX_LANDMARKS = 200;
const MAX_URL = 2000;
const MAX_LABEL = 300;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(v * 10_000) / 10_000;

function usablePlanUrl(url: string): boolean {
  if (url.length > MAX_URL) return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/** Convert the onboarding draft graph into an editor draft for `base` (the store's published map: mapId, version). */
export function draftToFloorPlan(view: GraphView, base: Pick<FloorPlan, "mapId" | "version">, planName = "Matterport floor plan"): DraftConversion {
  const notes: string[] = [];
  const img = view.plan && view.plan.w > 0 && view.plan.h > 0 && usablePlanUrl(view.plan.url) ? view.plan : null;
  if (view.plan && !img) notes.push("The Matterport floor plan image couldn't be used as the background (link too long or not HTTPS). Upload the plan in the editor.");

  const tx = img ? (x: number) => (x - img.x) / img.w : (x: number) => x;
  const ty = img ? (y: number) => (y - img.y) / img.h : (y: number) => y;
  const aspect = img ? (img.w * view.width_m) / (img.h * view.height_m) : view.width_m / view.height_m;

  let clamped = 0;
  const place = (x: number, y: number) => {
    const nx = tx(x), ny = ty(y);
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) clamped++;
    return { x: round(clamp01(nx)), y: round(clamp01(ny)) };
  };

  // Fresh short ids (Matterport sweep ids are long and the routes cap ids at 20 characters).
  const src = view.nodes.slice(0, MAX_NODES);
  if (view.nodes.length > MAX_NODES) notes.push(`Only the first ${MAX_NODES} of ${view.nodes.length} points were kept.`);
  const idOf = new Map<string, string>();
  let outdoor = 0;
  const nodes = src.map((n, i) => {
    const id = `p${i + 1}`;
    idOf.set(n.id, id);
    // The map routes don't accept "outdoor" points yet; keep them walkable.
    const kind: PlanNodeKind = n.kind === "outdoor" ? (outdoor++, "walk") : n.kind;
    return { id, ...place(n.x, n.y), kind };
  });
  if (outdoor) notes.push(`${outdoor} outdoor point${outdoor === 1 ? " is" : "s are"} imported as walk points.`);

  const seen = new Set<string>();
  const edges: [string, string][] = [];
  for (const [a, b] of view.edges) {
    const fa = idOf.get(a), fb = idOf.get(b);
    if (!fa || !fb || fa === fb) continue;
    const key = fa < fb ? `${fa}|${fb}` : `${fb}|${fa}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([fa, fb]);
    if (edges.length >= MAX_EDGES) break;
  }

  // Same position as the converted node (already clamped and counted).
  const landmarks = src
    .flatMap((n, i) => (n.landmark ? [{ n, at: nodes[i] }] : []))
    .slice(0, MAX_LANDMARKS)
    .map(({ n, at }, i) => ({ id: `L${i + 1}`, x: at.x, y: at.y, label: (n.label || `Landmark ${i + 1}`).slice(0, MAX_LABEL), verified: false }));

  if (clamped) notes.push(`${clamped} point${clamped === 1 ? " was" : "s were"} outside the floor plan image and moved to its edge.`);
  if (!nodes.some((n) => n.kind === "entrance")) notes.push("No entrance was found. Mark the entrance before publishing.");
  if (landmarks.length) notes.push(`${landmarks.length} landmark${landmarks.length === 1 ? "" : "s"} imported as unverified: photograph and confirm each one.`);
  notes.push("No shelves were imported. Draw shelf regions and give each a shelf ID; the publish checklist stays blocked until then.");

  return {
    plan: {
      mapId: base.mapId,
      version: base.version,
      plan: img ? { url: img.url, name: `${planName}${view.floor_label ? ` · ${view.floor_label}` : ""}`.slice(0, 200), kind: "image" } : null,
      aspect: Math.min(20, Math.max(0.05, Number.isFinite(aspect) && aspect > 0 ? aspect : 1)),
      nodes,
      edges,
      shelves: [],
      landmarks,
    },
    notes,
  };
}
