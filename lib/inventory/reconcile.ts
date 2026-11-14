// Adaptive inventory: turn what a shopper's camera saw into inventory updates. Pure (unit-tested).
//
// Rules:
//  - A sighting only counts when the shopper's position is known; the shelf comes from the map, not the image.
//  - Seen where the list says  → CONFIRM (refreshes "last seen"; changes nothing shoppers see, so no approval).
//  - Not in the list           → NEW_PRODUCT suggestion.
//  - Seen on a different shelf → MOVED suggestion.
//  - A shelf the camera clearly looked at (another product on it was seen) but a listed product wasn't there
//    → a MISS; repeated misses become a MISSING suggestion.
// Suggestions collect sightings until they reach a threshold, then wait for staff approval. Nothing here
// edits the published list.
import { normalize, scoreProduct } from "../search/matchProducts";
import type { PublishedProduct, StoreGraph } from "../types";

export interface Sighting {
  name: string;
  brand: string | null;
  variant: string | null;
  size: string | null;
  category: string | null;
  evidence: string;
  confidence: "high" | "medium" | "low";
}

export type SuggestionKind = "NEW_PRODUCT" | "MOVED" | "MISSING";

export interface ProposedProduct {
  name: string;
  brand: string | null;
  variant: string | null;
  size: string | null;
  category: string | null;
}

export interface SuggestionDelta {
  kind: SuggestionKind;
  /** Dedup key: one open suggestion per key per store. */
  key: string;
  product_id: string | null;
  proposed: ProposedProduct;
  /** Shelves the item could be on, given where the shopper stood. Staff pick one when approving. */
  shelf_ids: string[];
  evidence: string;
}

export interface ScanPlan {
  confirmed: string[]; // product ids seen at their listed shelf
  deltas: SuggestionDelta[];
}

/** Sightings needed before a suggestion reaches the staff queue. Staff approval is the real guard. */
export const THRESHOLDS: Record<SuggestionKind, number> = { NEW_PRODUCT: 1, MOVED: 2, MISSING: 3 };

/** Shelves visible from a node: those anchored at it (direct), else those anchored at adjacent nodes. */
export function shelvesInView(graph: StoreGraph, nodeId: string): { ids: string[]; direct: boolean } {
  const direct = graph.shelves.filter((s) => s.anchorNodeId === nodeId).map((s) => s.id);
  if (direct.length) return { ids: direct, direct: true };
  const adj = new Set(graph.edges.flatMap((e) => (e.from === nodeId ? [e.to] : e.to === nodeId ? [e.from] : [])));
  return { ids: graph.shelves.filter((s) => adj.has(s.anchorNodeId)).map((s) => s.id), direct: false };
}

// "64 FL OZ", "64 fl. oz", "64 ounces" and "64oz" all compare equal (shelf labels rarely distinguish fl oz).
const normSize = (s: string | null) =>
  s ? s.toLowerCase().replace(/\bfl(uid)?\.?\s*/g, "").replace(/ounces?/g, "oz").replace(/[^a-z0-9.]/g, "") : null;
const normBrand = (s: string | null) => (s ? normalize(s).replace(/[^a-z0-9 ]/g, "").trim() : null);

function brandsCompatible(a: string | null, b: string | null): boolean {
  const x = normBrand(a);
  const y = normBrand(b);
  return !x || !y || x === y || x.includes(y) || y.includes(x);
}

export type SightingMatch<P> = { kind: "match"; product: P } | { kind: "none" } | { kind: "ambiguous" };

/** Match a sighting to a listed product: name must match strongly, brand and size must not conflict. */
/** Vision models often put the brand in the name ("Silk Unsweetened Almond Milk"); strip brand words from it. */
function nameWithoutBrand(name: string, brand: string | null): string {
  const b = new Set((normBrand(brand) ?? "").split(" ").filter(Boolean));
  const kept = normalize(name).replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !b.has(w));
  return kept.length ? kept.join(" ") : name;
}

export function matchSighting<P extends PublishedProduct>(s: Sighting, products: P[]): SightingMatch<P> {
  const name = nameWithoutBrand(s.name, s.brand);
  const candidates = products.filter((p) => {
    if (!brandsCompatible(s.brand, p.brand) && !brandsCompatible(s.brand, `${p.brand ?? ""} ${p.name}`)) return false;
    const score = Math.max(scoreProduct(name, p), scoreProduct(s.name, p));
    // Strong name match, or a weaker one (e.g. extra variant words like "Original") backed by the same brand.
    const sameBrand = Boolean(s.brand && p.brand && normBrand(s.brand) === normBrand(p.brand));
    if (score < 80 && !(sameBrand && score >= 60)) return false;
    const a = normSize(s.size);
    const b = normSize(p.size);
    return !a || !b || a === b; // a different size is a different product (e.g. 32 oz vs 64 oz)
  });
  if (candidates.length === 1) return { kind: "match", product: candidates[0] };
  if (candidates.length === 0) {
    // Same brand + name but a size we don't list → genuinely new variant; otherwise new product.
    return { kind: "none" };
  }
  // Several listed products fit (e.g. no brand legible): don't guess, and don't call it new either.
  const exactBrand = candidates.filter((p) => s.brand && normBrand(p.brand) === normBrand(s.brand));
  return exactBrand.length === 1 ? { kind: "match", product: exactBrand[0] } : { kind: "ambiguous" };
}

export function planScan(args: { sightings: Sighting[]; products: PublishedProduct[]; graph: StoreGraph; nodeId: string }): ScanPlan {
  const { products, graph, nodeId } = args;
  const view = shelvesInView(graph, nodeId);
  const inView = new Set(view.ids);
  const confirmed = new Set<string>();
  const proven = new Set<string>(); // shelves the camera demonstrably looked at
  const deltas = new Map<string, SuggestionDelta>();

  for (const s of args.sightings) {
    if (s.confidence === "low" || !s.name.trim() || view.ids.length === 0) continue;
    const proposed: ProposedProduct = { name: s.name.trim(), brand: s.brand, variant: s.variant, size: s.size, category: s.category };
    const m = matchSighting(s, products);
    if (m.kind === "match") {
      const p = m.product;
      if (inView.has(p.location.shelfId)) {
        confirmed.add(p.id);
        proven.add(p.location.shelfId);
      } else if (view.direct) {
        // Only when the shopper stands at the shelves; from a walkway the camera may be seeing a far aisle.
        const key = `MOVED:${p.id}`;
        if (!deltas.has(key)) deltas.set(key, { kind: "MOVED", key, product_id: p.id, proposed: { ...proposed, name: p.name, brand: p.brand, size: p.size }, shelf_ids: view.ids, evidence: s.evidence });
      }
    } else if (m.kind === "none") {
      // Brand-stripped, sorted words: "Coconut Water" and "Vita Coco Coconut Water" from two scans are one suggestion.
      const words = nameWithoutBrand(s.name, s.brand).split(/\s+/).filter(Boolean).sort().join(" ");
      const key = `NEW:${normBrand(s.brand) ?? ""}|${words}|${normSize(s.size) ?? ""}`;
      if (!deltas.has(key)) deltas.set(key, { kind: "NEW_PRODUCT", key, product_id: null, proposed, shelf_ids: view.ids, evidence: s.evidence });
    }
  }

  if (view.direct) {
    for (const p of products) {
      if (!proven.has(p.location.shelfId) || confirmed.has(p.id)) continue;
      const key = `MISSING:${p.id}`;
      deltas.set(key, {
        kind: "MISSING",
        key,
        product_id: p.id,
        proposed: { name: p.name, brand: p.brand, variant: p.variant, size: p.size, category: p.category ?? null },
        shelf_ids: [p.location.shelfId],
        evidence: "Shelf was in view (other listed items seen) but this item was not.",
      });
    }
  }
  return { confirmed: [...confirmed], deltas: [...deltas.values()] };
}
