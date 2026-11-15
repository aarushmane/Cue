import { findItem, locateFromDetections } from "@/lib/wayfinding/locate";
import { planRouteToItem, planToNearest } from "@/lib/wayfinding/plan";
import { findInPhotos } from "@/lib/wayfinding/vision";
import { errorResponse, sceneFor, toOptions, toStart, WayfindingBody } from "@/lib/wayfinding/request";
import type { SceneItem } from "@/lib/wayfinding/types";
import { sceneCatalog, isCategoryQuery, matchCategory } from "@/lib/wayfinding/catalog";
import { normalize } from "@/lib/search/matchProducts";
import { WAYFINDING_TIMEOUT_MS, withAbort } from "@/lib/wayfinding/async";

// POST /api/wayfinding/route — deterministic: find the item (by id, by name, or from detections) and plan a route.
// Saved destinations by default; photo search requires search_photos: true.
export const maxDuration = 60;

export async function POST(request: Request) {
  const parsed = WayfindingBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST", issues: parsed.error.issues.slice(0, 3) }, { status: 400 });
  const body = parsed.data;
  if (!body.item_id && !body.query) return Response.json({ error: "BAD_REQUEST", issues: [{ message: "Send item_id or query." }] }, { status: 400 });

  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(WAYFINDING_TIMEOUT_MS)]);
  try {
    return await withAbort(planRequest(body, signal), signal);
  } catch (error) {
    return errorResponse(error);
  }
}

async function planRequest(body: WayfindingBody, signal: AbortSignal) {
  const scene = await sceneFor(body);
  const catalog = await sceneCatalog(scene);
  const known = new Set(scene.items.map((item) => item.id));
  scene.items = [...scene.items, ...catalog.filter((item) => !known.has(item.id))];
  signal.throwIfAborted();
  let item: SceneItem | undefined;
  if (body.item_id) {
    item = scene.items.find((i) => i.id === body.item_id);
    if (!item) return Response.json({ status: "ITEM_NOT_FOUND", reason: "No mapped item has that id." }, { status: 404 });
  } else {
    const match = findItem(body.query!, scene.items);
    if (match.status === "AMBIGUOUS") {
      if (new Set(match.options.map((item) => normalize(item.name))).size !== 1 && !isCategoryQuery(body.query!)) return Response.json({ status: "AMBIGUOUS", options: match.options });
      const nearest = planToNearest(scene, toStart(body.start, scene), match.options, toOptions(body.options))!;
      return Response.json({ status: nearest.plan.status, ...nearest });
    }
    if (match.status === "MATCH") item = match.item;
    else {
      // Not mapped: use supplied detections or category matches before an explicitly requested photo search.
      const seen = body.detections.find((d) => body.query!.toLowerCase().includes(d.label.toLowerCase()));
      if (seen) {
        const located = locateFromDetections(scene.waypoints, seen.detections, scene.obstacles, scene.surfaces);
        if (located.status !== "OK") return Response.json({ status: "ITEM_NOT_FOUND", reason: located.reason }, { status: 404 });
        item = { id: "vision-1", name: seen.label, position: located.position, source: "vision", confidence: located.confidence };
      } else {
        const categories = isCategoryQuery(body.query!) ? matchCategory(scene.items, body.query!) : [];
        if (categories.length) {
          const nearest = planToNearest(scene, toStart(body.start, scene), categories, toOptions(body.options))!;
          return Response.json({ status: nearest.plan.status, ...nearest });
        }
        if (!body.search_photos) return Response.json({ status: "ITEM_NOT_FOUND", reason: `I can't verify ${normalize(body.query!)} in the saved catalog.` }, { status: 404 });
        const found = await findInPhotos(scene, body.query!, { signal });
        if (found.status !== "OK") return Response.json({ status: found.status === "UNAVAILABLE" ? "SEARCH_UNAVAILABLE" : "ITEM_NOT_FOUND", reason: found.reason }, { status: found.status === "UNAVAILABLE" ? 503 : 404 });
        const nearest = planToNearest(scene, toStart(body.start, scene), found.items, toOptions(body.options))!;
        return Response.json({ status: nearest.plan.status, item: nearest.item, plan: nearest.plan, places: found.items.length });
      }
    }
  }
  const plan = planRouteToItem(scene, toStart(body.start, scene), item, toOptions(body.options));
  return Response.json({ status: plan.status, item, plan });
}
