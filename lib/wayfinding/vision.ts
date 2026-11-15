// Finding an item in the scan's photos. Server only.
//
// For each scan point, the four horizon faces of its skybox are sent to the configured vision model, which returns
// bounding boxes for the requested item. Box centres become detections (face, u, v); locate.ts turns them into 3D
// points by casting rays onto the scan mesh and keeping the position most photos agree on.
import "server-only";
import { z } from "zod";
import { structuredVision } from "../ai/structured";
import { aiConfigured } from "../ai/provider";
import { normalize } from "../search/matchProducts";
import sharp from "sharp";
import { isCategoryQuery, matchCatalog, matchCategory, sceneCatalog } from "./catalog";
import { skyboxTemplates } from "./scene";
import { locateFromDetections, surfaceClusters, type Detection } from "./locate";
import type { SceneItem, WayfindingScene } from "./types";

const MAX_SWEEPS = 12;
const HORIZON_FACES = [1, 2, 3, 4];

// Plain fields (bounds enforced below): Gemini rejects schemas whose constraints get too complex.
const Found = z.object({
  detections: z.array(z.object({
    face: z.number(),
    ymin: z.number(),
    xmin: z.number(),
    ymax: z.number(),
    xmax: z.number(),
    label: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});
const clamp = (x: number) => Math.max(0, Math.min(1000, x));

const WEIGHT = { high: 1, medium: 0.7, low: 0.35 } as const;

export type PhotoDetection = Detection & {
  label: string;
  /** Source photo (signed Matterport URL, short-lived) and the box in it, 0–1000. */
  image: string;
  box: { xmin: number; ymin: number; xmax: number; ymax: number };
};

/** Ask the vision model where `what` appears in each scan point's photos. */
export async function detectInPhotos(scene: WayfindingScene, what: string): Promise<PhotoDetection[]> {
  const templates = await skyboxTemplates(scene.modelId);
  // Only sweeps with orientation (from the Model API) can turn a pixel into a ray.
  const sweeps = scene.waypoints.filter((w) => w.rotation && templates.has(w.id)).slice(0, MAX_SWEEPS);
  const perSweep = await Promise.all(sweeps.map(async (w) => {
    const template = templates.get(w.id)!;
    const result = await structuredVision(Found, [
      { text: `Four photos taken from one spot inside a store, looking in four directions. Find every visible "${what}". Mark only things that are clearly ${what}, not similar products from another category.` },
      ...HORIZON_FACES.flatMap((face) => [{ text: `Face ${face}:` }, { image: template.replace("<face>", String(face)) }]),
      {
        text:
          "For each instance return the face number (1–4), its bounding box as ymin, xmin, ymax, xmax normalised to 0–1000 " +
          "within that face's image, a short label naming what you see (legible brand or sign text if any), and your confidence. " +
          "Only include things you can actually see. Return an empty list if it is not visible.",
      },
    ], { maxTokens: 2000, effort: "low" }).catch((error: unknown) => {
      console.warn(`vision: sweep ${w.id} failed`, error);
      return null;
    });
    return (result?.detections ?? [])
      .slice(0, 20)
      .map((d) => ({ ...d, xmin: clamp(d.xmin), xmax: clamp(d.xmax), ymin: clamp(d.ymin), ymax: clamp(d.ymax), label: d.label.slice(0, 200) }))
      .filter((d) => HORIZON_FACES.includes(d.face) && d.xmax > d.xmin && d.ymax > d.ymin)
      .map((d): PhotoDetection => ({
        sweepId: w.id, face: d.face,
        u: (d.xmin + d.xmax) / 2000, v: (d.ymin + d.ymax) / 2000,
        confidence: WEIGHT[d.confidence], label: d.label,
        image: template.replace("<face>", String(d.face)),
        box: { xmin: d.xmin, ymin: d.ymin, xmax: d.xmax, ymax: d.ymax },
      }));
  }));
  return perSweep.flat();
}

const Verdict = z.object({ is_match: z.boolean(), actually: z.string().max(200) });

/**
 * Second look at one detection: crop the box (with context) from its photo and ask a strict yes/no. Catches the
 * detector calling a nearby product category (pastries, candy) the requested one. null = could not check.
 */
async function verify(d: PhotoDetection, what: string): Promise<{ ok: boolean; actually: string } | null> {
  try {
    const url = new URL(d.image);
    if (!url.hostname.endsWith(".matterport.com")) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const source = Buffer.from(await response.arrayBuffer());
    const { width = 1024, height = 1024 } = await sharp(source).metadata();
    const cx = ((d.box.xmin + d.box.xmax) / 2000) * width, cy = ((d.box.ymin + d.box.ymax) / 2000) * height;
    const half = Math.max(96, (Math.max(d.box.xmax - d.box.xmin, d.box.ymax - d.box.ymin) / 1000) * Math.max(width, height) * 0.8);
    const left = Math.max(0, Math.round(cx - half)), top = Math.max(0, Math.round(cy - half));
    const crop = await sharp(source)
      .extract({ left, top, width: Math.min(width - left, Math.round(half * 2)), height: Math.min(height - top, Math.round(half * 2)) })
      .resize({ width: 512, height: 512, fit: "inside" })
      .jpeg({ quality: 85 })
      .toBuffer();
    const verdict = await structuredVision(Verdict, [
      { image: `data:image/jpeg;base64,${crop.toString("base64")}` },
      { text: `Is the product in the centre of this photo "${what}"? Answer is_match true only if it clearly is ${what}, not a similar product from another category. Say what it actually is.` },
    ], { maxTokens: 300, effort: "low" });
    return verdict ? { ok: verdict.is_match, actually: verdict.actually } : null;
  } catch (error) {
    console.warn("vision: verification failed", error);
    return null;
  }
}

export type VisionFind =
  | {
      status: "OK";
      /** Verified places the item was seen, best supported first. Route to the nearest with planToNearest. */
      items: SceneItem[];
      detections: number;
      rejected: { actually: string }[];
    }
  | { status: "NOT_SEEN" | "UNAVAILABLE"; reason: string; detections: number; rejected?: { actually: string }[] };

const cache = new Map<string, { at: number; value: Promise<VisionFind> }>();
const TTL_MS = 30 * 60_000;
const MAX_CANDIDATES = 4;

/**
 * Search the photos for an item the visitor asked for. Brands and products come from the scan's catalogue
 * (catalog.ts); anything else (a category like "chips") is searched directly: detect → place each detection on the
 * scan mesh → group into places → verify the best places with a cropped second look. Cached per model and query for
 * 30 minutes.
 */
export function findInPhotos(scene: WayfindingScene, query: string): Promise<VisionFind> {
  const what = normalize(query) || query.trim().toLowerCase();
  const key = `${scene.modelId}:${what}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const name = what.charAt(0).toUpperCase() + what.slice(1);
  const value = (async (): Promise<VisionFind> => {
    // Brands, products and categories: answer from the scan's catalogue (read once from zoomed-in photo tiles).
    const catalog = await sceneCatalog(scene).catch(() => [] as SceneItem[]);
    // A kind of product ("chips") means every place of that kind; a brand or product means its places.
    const [first, second] = isCategoryQuery(query) ? [matchCategory, matchCatalog] : [matchCatalog, matchCategory];
    const listed = first(catalog, query);
    const found = listed.length ? listed : second(catalog, query);
    if (found.length) return { status: "OK", items: found, detections: found.length, rejected: [] };
    if (!aiConfigured()) return { status: "UNAVAILABLE", reason: "No AI provider is configured to search the photos.", detections: 0 };

    const detections = await detectInPhotos(scene, what);
    if (!detections.length) return { status: "NOT_SEEN", reason: `No ${what} was spotted in this scan's photos.`, detections: 0 };

    if (!scene.surfaces?.length) {
      // No mesh: fall back to triangulation / fixtures, unverified.
      const located = locateFromDetections(scene.waypoints, detections, scene.obstacles);
      if (located.status !== "OK") return { status: "NOT_SEEN", reason: located.reason, detections: detections.length };
      return { status: "OK", detections: detections.length, rejected: [], items: [{ id: `vision:${what}:0`, name, position: located.position, source: "vision", confidence: located.confidence }] };
    }

    const places = surfaceClusters(scene.waypoints, detections, scene.surfaces).slice(0, MAX_CANDIDATES);
    const checked = await Promise.all(places.map(async (place) => {
      // Verify with the closest view: the most pixels on the product.
      const view = [...place.members].sort((a, b) => a.rangeM - b.rangeM)[0];
      return { place, verdict: await verify(view.detection, what) };
    }));
    const rejected = checked.filter((c) => c.verdict && !c.verdict.ok).map((c) => ({ actually: c.verdict!.actually }));
    const items = checked
      .filter((c) => !c.verdict || c.verdict.ok)
      .map(({ place, verdict }, i): SceneItem => ({
        id: `vision:${what}:${i}`, name, position: place.position, source: "vision",
        confidence: verdict ? place.confidence : Math.round(place.confidence * 50) / 100,
      }));
    if (!items.length) {
      return { status: "NOT_SEEN", reason: `What looked like ${what} turned out to be ${rejected.map((r) => r.actually).join(", ")}.`, detections: detections.length, rejected };
    }
    return { status: "OK", items, detections: detections.length, rejected };
  })();
  cache.set(key, { at: Date.now(), value });
  value.then((v) => { if (v.status !== "OK") cache.delete(key); }, () => cache.delete(key));
  return value;
}
