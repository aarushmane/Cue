// A product catalogue of the scan, read from its photos. Server only.
//
// Brands are too small to read when a vision model looks at a whole skybox face (90° of view in 1024 px), so each
// face is cut into six overlapping tiles, enlarged 2×, and the model lists every brand it can read with a box. Boxes
// become detections; locate.ts places them on the scan mesh and groups them per brand into places. Built once per
// scan (cached), so brand and product questions are answered from a list instead of a fresh photo search.
import "server-only";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { structuredVision } from "../ai/structured";
import { aiConfigured } from "../ai/provider";
import { normalize } from "../search/matchProducts";
import { surfaceClusters, type Detection } from "./locate";
import { skyboxTemplates } from "./scene";
import type { SceneItem, WayfindingScene } from "./types";

const HORIZON_FACES = [1, 2, 3, 4];
/** Tiles as fractions of the face: half-size squares, three across, two down over the lower ¾ (shelves, not ceiling). */
const TILES = [0, 0.25, 0.5].flatMap((x) => [0.1875, 0.5].map((y) => ({ x, y, size: 0.5 })));

// Plain fields only: Gemini rejects schemas whose bounds × item count get too complex ("invalid argument"), so ranges
// are enforced below instead.
const Listing = z.object({
  products: z.array(z.object({
    tile: z.number(),
    ymin: z.number(),
    xmin: z.number(),
    ymax: z.number(),
    xmax: z.number(),
    brand: z.string(),
    product: z.string(),
    category: z.string(),
    confidence: z.enum(["high", "medium", "low"]),
  })),
});
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const WEIGHT = { high: 1, medium: 0.7, low: 0.35 } as const;

type Seen = Detection & { brand: string; product: string; category: string };

async function readFace(sweepId: string, face: number, url: string): Promise<Seen[]> {
  const source = new URL(url);
  if (!source.hostname.endsWith(".matterport.com")) return [];
  const response = await fetch(source, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) return [];
  const image = Buffer.from(await response.arrayBuffer());
  const { width = 1024, height = 1024 } = await sharp(image).metadata();
  const tiles = await Promise.all(TILES.map(async (t) => {
    const crop = await sharp(image)
      .extract({ left: Math.round(t.x * width), top: Math.round(t.y * height), width: Math.round(t.size * width), height: Math.round(t.size * height) })
      .resize({ width: 1024, height: 1024 })
      .jpeg({ quality: 88 })
      .toBuffer();
    return `data:image/jpeg;base64,${crop.toString("base64")}`;
  }));
  const listing = await structuredVision(Listing, [
    { text: `${TILES.length} zoomed-in crops of one photo taken inside a store.` },
    ...tiles.flatMap((image, i) => [{ text: `Tile ${i + 1}:` }, { image }]),
    {
      text:
        "List every product brand on display that you can actually read or recognise from its packaging (for example " +
        "Doritos, Takis, Snickers, Coca-Cola). For each, give the tile number, a box around that product group as ymin, " +
        "xmin, ymax, xmax normalised to 0–1000 within the tile, the brand, the product name or flavour if legible, a " +
        "one- or two-word category (chips, candy, chocolate, soda, energy drink, water, snack cakes, cookies, gum, jerky, " +
        "nuts, …) and your confidence. One entry per brand per place. Do not guess brands you cannot recognise.",
    },
  ], { maxTokens: 6000, effort: "low" });
  return (listing?.products ?? [])
    .slice(0, 80)
    .map((p) => ({ ...p, xmin: clamp(p.xmin, 0, 1000), xmax: clamp(p.xmax, 0, 1000), ymin: clamp(p.ymin, 0, 1000), ymax: clamp(p.ymax, 0, 1000), brand: p.brand.slice(0, 60), product: p.product.slice(0, 120), category: p.category.slice(0, 40) }))
    .filter((p) => Number.isInteger(p.tile) && p.tile >= 1 && p.tile <= TILES.length && p.xmax > p.xmin && p.ymax > p.ymin && p.brand.trim())
    .map((p) => {
      const t = TILES[p.tile - 1];
      return {
        sweepId, face,
        u: t.x + (t.size * (p.xmin + p.xmax)) / 2000,
        v: t.y + (t.size * (p.ymin + p.ymax)) / 2000,
        confidence: WEIGHT[p.confidence],
        brand: p.brand.trim(), product: p.product.trim(), category: p.category.trim().toLowerCase(),
      };
    });
}

const key = (brand: string) => normalize(brand).replace(/ /g, "");
/** Placeholder "brands" the model sometimes returns when it can't read one. */
const NOT_A_BRAND = new Set(["unknown", "generic", "na", "none", "various", "other", "unbranded", "brand", "unclear", "illegible"]);

/** Read every photo point's horizon faces and turn what was read into placed items, one per brand per place. */
export async function buildCatalog(scene: WayfindingScene): Promise<SceneItem[]> {
  if (!scene.surfaces?.length) return [];
  const templates = await skyboxTemplates(scene.modelId);
  const sweeps = scene.waypoints.filter((w) => w.rotation && templates.has(w.id));
  const seen = (await Promise.all(sweeps.flatMap((w) => HORIZON_FACES.map((face) =>
    readFace(w.id, face, templates.get(w.id)!.replace("<face>", String(face))).catch((error: unknown) => {
      console.warn(`catalog: ${w.id} face ${face} failed`, error);
      return [] as Seen[];
    }))))).flat();

  const byBrand = new Map<string, Seen[]>();
  for (const s of seen) {
    const k = key(s.brand);
    if (k.length < 2 || NOT_A_BRAND.has(k)) continue;
    byBrand.set(k, [...(byBrand.get(k) ?? []), s]);
  }
  const items: SceneItem[] = [];
  for (const [k, group] of byBrand) {
    surfaceClusters(scene.waypoints, group, scene.surfaces).forEach((place, i) => {
      const members = place.members.map((m) => m.detection);
      const most = (values: string[]) => [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
      items.push({
        id: `catalog:${k}:${i}`,
        name: most(members.map((m) => m.brand)),
        brand: most(members.map((m) => m.brand)),
        aliases: [...new Set(members.map((m) => m.product).filter(Boolean))].slice(0, 10),
        category: most(members.map((m) => m.category).filter(Boolean)) || null,
        position: place.position,
        source: "vision",
        confidence: Math.min(1, Math.round(place.confidence * 100) / 100),
      });
    });
  }
  return items;
}

const catalogs = new Map<string, { at: number; ttl: number; build: boolean; value: Promise<SceneItem[]> }>();
const TTL_MS = 7 * 24 * 60 * 60_000;
/** An empty or failed build (e.g. the AI quota ran out) is not retried for this long, so it doesn't burn quota. */
const RETRY_MS = 10 * 60_000;
// Built catalogues are kept on disk too, so restarts don't re-read every photo (one vision call per photo face).
const diskPath = (modelId: string) => path.join(tmpdir(), "storeguide-wayfinding", `${modelId}.catalog.json`);

/** A catalogue checked into the repo (built with `npm run wayfinding:catalog`), used as is: no AI calls at all. */
export const savedCatalogPath = (modelId: string) => path.join(process.cwd(), "data", "wayfinding", `${modelId}.catalog.json`);

async function fromDisk(modelId: string): Promise<SceneItem[] | null> {
  for (const [file, maxAge] of [[savedCatalogPath(modelId), Infinity], [diskPath(modelId), TTL_MS]] as const) {
    try {
      const saved = JSON.parse(await readFile(file, "utf8")) as { at: number; items: SceneItem[] };
      if (Date.now() - saved.at < maxAge && Array.isArray(saved.items) && saved.items.length) return saved.items;
    } catch {
      // not there or unreadable: next
    }
  }
  return null;
}

/** The scan's catalogue: from memory, else from disk, else built (cached for a week; empty builds retried after 10 min). */
export function sceneCatalog(scene: WayfindingScene, options: { build?: boolean } = {}): Promise<SceneItem[]> {
  if (!/^[a-zA-Z0-9]{11}$/.test(scene.modelId)) return Promise.resolve([]);
  const hit = catalogs.get(scene.modelId);
  if (hit && Date.now() - hit.at < hit.ttl && (!options.build || hit.build)) return hit.value;
  const entry = { at: Date.now(), ttl: TTL_MS, build: Boolean(options.build), value: Promise.resolve([] as SceneItem[]) };
  entry.value = (async () => {
    const saved = await fromDisk(scene.modelId);
    if (saved) return saved;
    // Interactive requests never kick off an expensive full-store indexing job.
    if (!options.build) { entry.ttl = RETRY_MS; return []; }
    if (!aiConfigured()) { entry.ttl = RETRY_MS; return []; }
    const items = await buildCatalog(scene).catch((error: unknown) => { console.warn("catalog: build failed", error); return []; });
    if (!items.length) { entry.ttl = RETRY_MS; return items; }
    console.info(`catalog: ${scene.modelId} has ${items.length} placed products`);
    await mkdir(path.dirname(diskPath(scene.modelId)), { recursive: true })
      .then(() => writeFile(diskPath(scene.modelId), JSON.stringify({ at: Date.now(), items })))
      .catch(() => {});
    return items;
  })();
  catalogs.set(scene.modelId, entry);
  return entry.value;
}

export { isCategoryQuery, matchCatalog, matchCategory } from "./catalogMatch";
