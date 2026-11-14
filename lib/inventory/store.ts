// Adaptive inventory persistence. Supabase (service role, after a staff check in the route) when configured;
// otherwise in-memory alongside the seeded demo store. Shopper data stored here is structured text only:
// no images, no shopper identity.
import { getAdminDb } from "../db/admin";
import { getRepo, memoryAddProduct, memoryInventory, memoryMoveProduct, memoryRetireLocation } from "../db/repo";
import type { ShelfLevel } from "../types";
import { THRESHOLDS, type ProposedProduct, type ScanPlan, type SuggestionKind } from "./reconcile";

export type SuggestionStatus = "COLLECTING" | "PENDING" | "APPROVED" | "REJECTED" | "AUTO_RESOLVED";

export interface Suggestion {
  id: string;
  store_id: string;
  kind: SuggestionKind;
  status: SuggestionStatus;
  key: string;
  product_id: string | null;
  proposed: ProposedProduct;
  shelf_counts: Record<string, number>; // shelf id → sightings placing it there
  sighting_count: number;
  threshold: number;
  evidence: string[]; // last few evidence strings from the vision model
  first_seen_at: string;
  last_seen_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}

export interface InventoryRow {
  product_id: string;
  name: string;
  brand: string | null;
  variant: string | null;
  size: string | null;
  category: string | null;
  shelf_id: string;
  aisle: string;
  section: string;
  level: ShelfLevel | null;
  verified_at: string;
  last_seen_at: string | null;
  miss_count: number;
}

export interface ApproveInput {
  shelf_id?: string;
  level?: ShelfLevel | null;
  edits?: Partial<ProposedProduct>;
}

export type ReviewResult = { ok: true; suggestion: Suggestion; product_id: string | null } | { ok: false; status: 400 | 404 | 409; error: string };

const OPEN: SuggestionStatus[] = ["COLLECTING", "PENDING"];
const MAX_EVIDENCE = 5;

/** Most-sighted shelf, the default when staff don't pick one. */
export function topShelf(counts: Record<string, number>): string | null {
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
}

// ───────────────────────────── Memory ─────────────────────────────
const mem: Suggestion[] = [];

function memApplyScan(storeId: string, plan: ScanPlan): number {
  const now = new Date().toISOString();
  const { locations } = memoryInventory();
  for (const id of plan.confirmed) {
    const loc = locations.find((l) => l.productId === id);
    if (loc) {
      loc.lastSeenAt = now;
      loc.missCount = 0;
    }
    // Adaptive: seeing it again resolves an open "missing" suggestion on its own.
    for (const s of mem) if (s.kind === "MISSING" && s.product_id === id && OPEN.includes(s.status)) Object.assign(s, { status: "AUTO_RESOLVED", review_note: "Seen again by a shopper.", reviewed_at: now });
  }
  for (const d of plan.deltas) {
    if (d.kind === "MISSING") {
      const loc = locations.find((l) => l.productId === d.product_id);
      if (loc) loc.missCount = (loc.missCount ?? 0) + 1;
    }
    let s = mem.find((x) => x.store_id === storeId && x.key === d.key && OPEN.includes(x.status));
    if (!s) {
      s = {
        id: `sg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        store_id: storeId, kind: d.kind, status: "COLLECTING", key: d.key, product_id: d.product_id, proposed: d.proposed,
        shelf_counts: {}, sighting_count: 0, threshold: THRESHOLDS[d.kind], evidence: [], first_seen_at: now, last_seen_at: now,
        reviewed_by: null, reviewed_at: null, review_note: null,
      };
      mem.push(s);
    }
    s.sighting_count += 1;
    s.last_seen_at = now;
    for (const sh of d.shelf_ids) s.shelf_counts[sh] = (s.shelf_counts[sh] ?? 0) + 1;
    s.evidence = [d.evidence, ...s.evidence].slice(0, MAX_EVIDENCE);
    if (s.status === "COLLECTING" && s.sighting_count >= s.threshold) s.status = "PENDING";
  }
  return plan.deltas.length;
}

function memReview(id: string, approve: boolean, input: ApproveInput & { note?: string }, actor: string): ReviewResult {
  const s = mem.find((x) => x.id === id);
  if (!s) return { ok: false, status: 404, error: "Suggestion not found." };
  if (s.status !== "PENDING") return { ok: false, status: 409, error: `Suggestion is ${s.status}, not PENDING.` };
  let productId = s.product_id;
  if (approve) {
    const shelf = input.shelf_id ?? topShelf(s.shelf_counts);
    const p = { ...s.proposed, ...input.edits };
    if (s.kind === "NEW_PRODUCT") {
      if (!shelf || !p.name?.trim()) return { ok: false, status: 400, error: "A shelf and a product name are required." };
      productId = memoryAddProduct({ storeId: s.store_id, name: p.name.trim(), brand: p.brand ?? null, variant: p.variant ?? null, size: p.size ?? null, category: p.category ?? null, aliases: [] }, shelf, input.level ?? null);
      if (!productId) return { ok: false, status: 400, error: "Unknown shelf." };
    } else if (s.kind === "MOVED") {
      if (!shelf || !memoryMoveProduct(s.product_id!, shelf, input.level ?? null)) return { ok: false, status: 400, error: "Unknown product or shelf." };
    } else if (!memoryRetireLocation(s.product_id!)) {
      return { ok: false, status: 409, error: "This item is no longer listed." };
    }
  }
  Object.assign(s, { status: approve ? "APPROVED" : "REJECTED", reviewed_by: actor, reviewed_at: new Date().toISOString(), review_note: input.note ?? null });
  return { ok: true, suggestion: s, product_id: productId };
}

// ───────────────────────────── Public API ─────────────────────────────

/** Record a scan's plan. Never throws into the shopper flow's caller: callers catch and ignore. */
export async function applyScan(storeId: string, plan: ScanPlan): Promise<number> {
  if (plan.confirmed.length === 0 && plan.deltas.length === 0) return 0;
  const db = getAdminDb();
  if (!db) return memApplyScan(storeId, plan);
  if (plan.confirmed.length) {
    const { error } = await db.rpc("confirm_sightings", { p_store_id: storeId, p_product_ids: plan.confirmed });
    if (error) throw new Error(error.message);
  }
  for (const d of plan.deltas) {
    const { error } = await db.rpc("record_sighting", {
      p_store_id: storeId, p_kind: d.kind, p_key: d.key, p_product_id: d.product_id, p_proposed: d.proposed,
      p_shelf_ids: d.shelf_ids, p_evidence: d.evidence, p_threshold: THRESHOLDS[d.kind],
    });
    if (error) throw new Error(error.message);
  }
  return plan.deltas.length;
}

export async function listSuggestions(storeId: string, statuses: SuggestionStatus[] = ["PENDING"]): Promise<Suggestion[]> {
  const db = getAdminDb();
  if (!db) return mem.filter((s) => s.store_id === storeId && statuses.includes(s.status)).sort((a, b) => b.last_seen_at.localeCompare(a.last_seen_at));
  const { data, error } = await db.from("inventory_suggestions").select("*").eq("store_id", storeId).in("status", statuses).order("last_seen_at", { ascending: false }).limit(200);
  if (error) throw new Error(error.message);
  return data as Suggestion[];
}

export async function listInventory(storeId: string): Promise<InventoryRow[]> {
  const db = getAdminDb();
  if (!db) {
    const published = await getRepo().listPublishedProducts(storeId);
    return published.map((p) => ({
      product_id: p.id, name: p.name, brand: p.brand, variant: p.variant, size: p.size, category: p.category ?? null,
      shelf_id: p.shelf.id, aisle: p.shelf.aisle, section: p.shelf.section, level: p.location.level, verified_at: p.location.verifiedAt,
      last_seen_at: p.location.lastSeenAt ?? null, miss_count: p.location.missCount ?? 0,
    }));
  }
  const { data, error } = await db
    .from("product_locations")
    .select("shelf_id, level, verified_at, last_seen_at, miss_count, products!inner(id, store_id, name, brand, variant, size, category), shelves!inner(aisle, section)")
    .eq("status", "PUBLISHED")
    .eq("products.store_id", storeId);
  if (error) throw new Error(error.message);
  return (data as unknown as {
    shelf_id: string; level: ShelfLevel | null; verified_at: string; last_seen_at: string | null; miss_count: number;
    products: { id: string; name: string; brand: string | null; variant: string | null; size: string | null; category: string | null };
    shelves: { aisle: string; section: string };
  }[]).map((r) => ({
    product_id: r.products.id, name: r.products.name, brand: r.products.brand, variant: r.products.variant, size: r.products.size, category: r.products.category,
    shelf_id: r.shelf_id, aisle: r.shelves.aisle, section: r.shelves.section, level: r.level, verified_at: r.verified_at, last_seen_at: r.last_seen_at, miss_count: r.miss_count,
  }));
}

/** Store id of a suggestion, so the route can check the caller is staff for that store. */
export async function suggestionStore(id: string): Promise<string | null> {
  const db = getAdminDb();
  if (!db) return mem.find((s) => s.id === id)?.store_id ?? null;
  const { data } = await db.from("inventory_suggestions").select("store_id").eq("id", id).maybeSingle();
  return data?.store_id ?? null;
}

export async function reviewSuggestion(
  id: string,
  decision: "approve" | "reject",
  input: ApproveInput & { note?: string },
  actor: { userId: string | null; label: string },
): Promise<ReviewResult> {
  const db = getAdminDb();
  if (!db) return memReview(id, decision === "approve", input, actor.label);
  const { data, error } = await db.rpc(decision === "approve" ? "approve_suggestion" : "reject_suggestion", {
    p_id: id,
    ...(decision === "approve" ? { p_shelf_id: input.shelf_id ?? null, p_level: input.level ?? null, p_edits: input.edits ?? {} } : {}),
    p_note: input.note ?? null,
    p_actor: actor.userId,
    p_actor_label: actor.label,
  });
  if (error) {
    const status = /not found/i.test(error.message) ? 404 : /not pending/i.test(error.message) ? 409 : 400;
    return { ok: false, status, error: error.message };
  }
  const row = data as { suggestion: Suggestion; product_id: string | null };
  return { ok: true, suggestion: row.suggestion, product_id: row.product_id };
}
