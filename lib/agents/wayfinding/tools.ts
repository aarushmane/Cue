// Wayfinding agent tools (LangChain `tool` + zod). Each wraps deterministic code in lib/wayfinding; the model never
// computes positions, distances or directions itself, and route text is produced by templates in the planner.
import { tool } from "langchain";
import { z } from "zod";
import { findItem, locateFromDetections, type Detection } from "../../wayfinding/locate";
import { planRouteToItem, planToNearest } from "../../wayfinding/plan";
import type { RoutePlan, SceneItem, StartPoint, WayfindingScene } from "../../wayfinding/types";

/** Mutable per-run state the tools read and write. One instance per agent run. */
export interface WayfindingRun {
  scene: WayfindingScene;
  start: StartPoint;
  /** Photo detections supplied with the request (from a vision model or staff), keyed by what they show. */
  detections: { label: string; detections: Detection[] }[];
  /** Searches the scan's photos for an item (vision model + mesh). Injected so tests can stub it. */
  searchPhotos?: (query: string) => Promise<{ status: string; items?: SceneItem[]; reason?: string; detections: number }>;
  item?: SceneItem;
  plan?: RoutePlan;
  log: { at: string; event: string; detail?: unknown }[];
}

const json = (v: unknown) => JSON.stringify(v);
const r2 = (x: number) => Math.round(x * 100) / 100;
const log = (run: WayfindingRun, event: string, detail?: unknown) => run.log.push({ at: new Date().toISOString(), event, detail });
const brief = (i: SceneItem) => ({ item_id: i.id, name: i.name, category: i.category ?? null, source: i.source, confidence: i.confidence ?? null });

export function wayfindingTools(run: WayfindingRun) {
  const find = tool(
    async ({ query }) => {
      const match = findItem(query, run.scene.items);
      log(run, "find_item", { query, status: match.status });
      if (match.status === "MATCH") { run.item = match.item; return json({ status: "MATCH", item: brief(match.item) }); }
      if (match.status === "AMBIGUOUS") return json({ status: "AMBIGUOUS", options: match.options.map(brief) });
      return json({
        status: "NO_MATCH",
        mapped_items: run.scene.items.length,
        detections_available: run.detections.map((d) => d.label),
      });
    },
    {
      name: "find_item",
      description: "Find a mapped item in this space from the visitor's words (name, brand, alias or category). Returns one match, several options, or none.",
      schema: z.object({ query: z.string().describe("What the visitor asked for, e.g. 'chips'") }),
    },
  );

  const locate = tool(
    async ({ label }) => {
      const entry = run.detections.find((d) => d.label.toLowerCase() === label.toLowerCase());
      if (!entry) {
        // No detections supplied: look for it in the scan's photos.
        if (!run.searchPhotos) return json({ status: "NO_DETECTIONS", available: run.detections.map((d) => d.label) });
        const found = await run.searchPhotos(label);
        log(run, "locate_item", { label, via: "photos", status: found.status, detections: found.detections });
        if (found.status !== "OK" || !found.items?.length) return json({ status: found.status, reason: found.reason, detections: found.detections });
        // Seen in several places: offer the nearest one.
        run.scene.items.push(...found.items);
        const nearest = planToNearest(run.scene, run.start, found.items)!;
        run.item = nearest.item;
        return json({ status: "OK", item: brief(nearest.item), method: "photos", places_seen: found.items.length, detections: found.detections });
      }
      const result = locateFromDetections(run.scene.waypoints, entry.detections, run.scene.obstacles, run.scene.surfaces);
      log(run, "locate_item", { label, status: result.status });
      if (result.status !== "OK") return json(result);
      const item: SceneItem = {
        id: `vision-${run.scene.items.length + 1}`, name: entry.label, position: result.position, source: "vision", confidence: result.confidence,
      };
      run.scene.items.push(item);
      run.item = item;
      return json({ status: "OK", item: brief(item), method: result.method, residual_m: result.residualM, position: { x: r2(item.position.x), y: r2(item.position.y), z: r2(item.position.z) } });
    },
    {
      name: "locate_item",
      description: "Find something that is not mapped by searching the store's 360° photos (or detections supplied with the request) and estimate where it is. Use when find_item returns NO_MATCH.",
      schema: z.object({ label: z.string().describe("One of detections_available") }),
    },
  );

  const plan = tool(
    async ({ item_id }) => {
      const item = run.scene.items.find((i) => i.id === item_id);
      if (!item) return json({ status: "ITEM_NOT_FOUND", reason: "Unknown item id; call find_item first." });
      const result = planRouteToItem(run.scene, run.start, item);
      run.item = item;
      run.plan = result;
      log(run, "plan_route", { item_id, status: result.status });
      if (result.status !== "OK" && result.status !== "ALREADY_THERE") return json(result);
      return json({
        status: result.status,
        total_distance_m: result.totalDistanceM,
        directions: result.legs.map((l) => l.text),
        scan_points: result.waypointIds.length,
        arrows: result.arrows.length,
        warnings: result.warnings,
      });
    },
    {
      name: "plan_route",
      description: "Plan an obstacle-free walking route from the visitor to an item and get turn-by-turn directions. The route and floor arrows are shown to the visitor automatically.",
      schema: z.object({ item_id: z.string() }),
    },
  );

  return [find, locate, plan];
}
