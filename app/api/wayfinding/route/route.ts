import { findItem, locateFromDetections } from "@/lib/wayfinding/locate";
import { planRouteToItem, planToNearest } from "@/lib/wayfinding/plan";
import { findInPhotos } from "@/lib/wayfinding/vision";
import { errorResponse, sceneFor, toOptions, toStart, WayfindingBody } from "@/lib/wayfinding/request";
import type { SceneItem } from "@/lib/wayfinding/types";

// POST /api/wayfinding/route — deterministic: find the item (by id, by name, or from detections) and plan a route.
// No model call; this is what the UI uses when the visitor picks an item directly.
export const maxDuration = 60;

export async function POST(request: Request) {
  const parsed = WayfindingBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST", issues: parsed.error.issues.slice(0, 3) }, { status: 400 });
  const body = parsed.data;
  if (!body.item_id && !body.query) return Response.json({ error: "BAD_REQUEST", issues: [{ message: "Send item_id or query." }] }, { status: 400 });

  try {
    const scene = await sceneFor(body);
    let item: SceneItem | undefined;
    if (body.item_id) {
      item = scene.items.find((i) => i.id === body.item_id);
      if (!item) return Response.json({ status: "ITEM_NOT_FOUND", reason: "No mapped item has that id." }, { status: 404 });
    } else {
      const match = findItem(body.query!, scene.items);
      if (match.status === "AMBIGUOUS") return Response.json({ status: "AMBIGUOUS", options: match.options });
      if (match.status === "MATCH") item = match.item;
      else {
        // Not mapped: use detections sent with the request, otherwise search the scan's photos.
        const seen = body.detections.find((d) => body.query!.toLowerCase().includes(d.label.toLowerCase()));
        if (seen) {
          const located = locateFromDetections(scene.waypoints, seen.detections, scene.obstacles, scene.surfaces);
          if (located.status !== "OK") return Response.json({ status: "ITEM_NOT_FOUND", reason: located.reason }, { status: 404 });
          item = { id: "vision-1", name: seen.label, position: located.position, source: "vision", confidence: located.confidence };
        } else {
          const found = await findInPhotos(scene, body.query!);
          if (found.status !== "OK") return Response.json({ status: "ITEM_NOT_FOUND", reason: found.reason }, { status: 404 });
          const nearest = planToNearest(scene, toStart(body.start, scene), found.items, toOptions(body.options))!;
          return Response.json({ status: nearest.plan.status, item: nearest.item, plan: nearest.plan, places: found.items.length });
        }
      }
    }
    const plan = planRouteToItem(scene, toStart(body.start, scene), item, toOptions(body.options));
    return Response.json({ status: plan.status, item, plan });
  } catch (error) {
    return errorResponse(error);
  }
}
