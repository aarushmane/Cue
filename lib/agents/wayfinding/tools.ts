// Wayfinding agent tools (LangChain `tool` + zod). Each wraps deterministic code in lib/wayfinding; the model never
// computes positions, distances or directions itself, and route text is produced by templates in the planner.
import { tool } from "langchain";
import { z } from "zod";
import { findItem, locateFromDetections, type Detection } from "../../wayfinding/locate";
import { planRouteToItem, planToNearest } from "../../wayfinding/plan";
import type { RoutePlan, SceneItem, StartPoint, WayfindingScene } from "../../wayfinding/types";
import type { VoiceEvent } from "@/lib/voice/types";
import { normalize } from "@/lib/search/matchProducts";
import { isCategoryQuery } from "@/lib/wayfinding/catalogMatch";

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
  onEvent?: (event: VoiceEvent) => void;
  targetQuery?: string;
  lockedItemId?: string;
  searchQuery?: string;
}

const json = (v: unknown) => JSON.stringify(v);
const r2 = (x: number) => Math.round(x * 100) / 100;
const log = (run: WayfindingRun, event: string, detail?: unknown) => run.log.push({ at: new Date().toISOString(), event, detail });
const brief = (i: SceneItem) => ({ item_id: i.id, name: i.name, category: i.category ?? null, source: i.source, confidence: i.confidence ?? null });

export function wayfindingTools(run: WayfindingRun) {
  const memo = new Map<string, string>();
  const find = tool(
    async ({ query }) => {
      if (run.lockedItemId) {
        const item = run.scene.items.find((item) => item.id === run.lockedItemId);
        if (item) { run.item = item; return json({ status: "MATCH", item: brief(item), method: "locked_destination" }); }
      }
      query = run.searchQuery ?? query;
      if (memo.has(`find:${query}`)) return memo.get(`find:${query}`)!;
      run.onEvent?.({ type: "progress", stage: "finding", label: "Finding destination" });
      const match = findItem(query, run.scene.items);
      log(run, "find_item", { query, status: match.status });
      if (match.status === "MATCH") { run.item = match.item; const result = json({ status: "MATCH", item: brief(match.item) }); memo.set(`find:${query}`, result); return result; }
      if (match.status === "AMBIGUOUS" && new Set(match.options.map((item) => normalize(item.name))).size === 1) {
        const nearest = planToNearest(run.scene, run.start, match.options);
        if (nearest) { run.item = nearest.item; return json({ status: "MATCH", item: brief(nearest.item), method: "nearest_location" }); }
      }
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
      if (run.lockedItemId) return json({ status: "TARGET_LOCKED", reason: "The destination is already selected; use read_route. Do not search again." });
      label = run.searchQuery ?? label;
      if (memo.has(`locate:${label}`)) return memo.get(`locate:${label}`)!;
      run.onEvent?.({ type: "progress", stage: "locating", label: "Looking through the scene" });
      const entry = run.detections.find((d) => d.label.toLowerCase() === label.toLowerCase());
      if (!entry) {
        // No detections supplied: look for it in the scan's photos.
        if (!run.searchPhotos) return json({ status: "NO_DETECTIONS", available: run.detections.map((d) => d.label) });
        const found = await run.searchPhotos(label);
        log(run, "locate_item", { label, via: "photos", status: found.status, detections: found.detections });
        if (found.status !== "OK" || !found.items?.length) {
          const result = json({ status: found.status, reason: found.reason, detections: found.detections }); memo.set(`locate:${label}`, result); return result;
        }
        // Seen in several places: offer the nearest one.
        run.scene.items.push(...found.items);
        const nearest = planToNearest(run.scene, run.start, found.items)!;
        run.item = nearest.item;
        const result = json({ status: "OK", item: brief(nearest.item), method: "photos", places_seen: found.items.length, detections: found.detections }); memo.set(`locate:${label}`, result); return result;
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
      if (memo.has(`plan:${item_id}`)) return memo.get(`plan:${item_id}`)!;
      run.onEvent?.({ type: "progress", stage: "routing", label: "Drawing path" });
      const item = run.scene.items.find((i) => i.id === item_id);
      if (!item) return json({ status: "ITEM_NOT_FOUND", reason: "Unknown item id; call find_item first." });
      if (run.searchQuery && !isCategoryQuery(run.searchQuery) && findItem(run.searchQuery, [item]).status !== "MATCH") {
        return json({ status: "WRONG_DESTINATION", reason: `The exact requested product is ${run.searchQuery}. Do not substitute ${item.name}; report that the requested product could not be verified.` });
      }
      if (run.lockedItemId && run.lockedItemId !== item.id) return json({ status: "TARGET_LOCKED", reason: "Keep the current destination. The visitor must explicitly request a new one to change it." });
      if (run.targetQuery) {
        const requested = findItem(run.targetQuery, run.scene.items);
        const allowed = requested.status === "MATCH" ? [requested.item] : requested.status === "AMBIGUOUS" ? requested.options : [];
        if (allowed.length && !allowed.some((target) => target.id === item.id)) {
          return json({ status: "WRONG_DESTINATION", reason: `The visitor requested ${allowed.map((target) => target.name).join(" or ")}. Find and plan that destination; do not substitute ${item.name}.` });
        }
      }
      const result = planRouteToItem(run.scene, run.start, item);
      run.item = item;
      run.plan = result;
      if (result.status === "OK" || result.status === "ALREADY_THERE") run.lockedItemId = item.id;
      run.onEvent?.({ type: "route", item, plan: result });
      log(run, "plan_route", { item_id, status: result.status });
      if (result.status !== "OK" && result.status !== "ALREADY_THERE") { const answer = json(result); memo.set(`plan:${item_id}`, answer); return answer; }
      const answer = json({
        status: result.status,
        total_distance_m: result.totalDistanceM,
        directions: result.legs.map((l) => l.text),
        scan_points: result.waypointIds.length,
        arrows: result.arrows.length,
        warnings: result.warnings,
      });
      memo.set(`plan:${item_id}`, answer); return answer;
    },
    {
      name: "plan_route",
      description: "Plan an obstacle-free walking route from the visitor to an item and get turn-by-turn directions. The route and floor arrows are shown to the visitor automatically.",
      schema: z.object({ item_id: z.string() }),
    },
  );

  return [find, locate, plan];
}
