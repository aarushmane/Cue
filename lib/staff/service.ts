// Staff and shopper writes behind the real API routes. Two backends, one contract:
// - Supabase (service role, after requireStaff in the route): SQL functions from 004_review_v4.sql, so each
//   write is one transaction.
// - Memory mode: the same in-memory demo backend the manager screens use (lib/db/demoState.ts), with the seeded
//   DEMO_STAFF as the actor (memory-mode auth is the shared STAFF_DEMO_TOKEN, so there is no individual identity).
// Results are { status, body } so routes stay thin.
import { getAdminDb } from "../db/admin";
import {
  listObservations, listProducts, moveProduct as memMove, publishMap as memPublishMap, reviewObservation as memReview,
  saveMapDraft as memSaveMap, submitShopperObservation as memSubmit,
} from "../db/demoState";
import { DEMO_STAFF } from "../seed/demo-review";
import { DEMO_STORE } from "../seed/demo-store";
import type { FloorPlan, ObservationCandidate, ReviewDraft, ShelfLevel } from "../types";

export type Out = { status: number; body: Record<string, unknown> };
export interface Actor { userId: string | null; label: string }

export const supabaseMode = () => !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

const CODE_STATUS: Record<string, number> = {
  OK: 200, NOT_FOUND: 404, ALREADY_REVIEWED: 409, CONFLICT: 409, TARGET_CONFLICT: 409, INVALID: 422,
};
const fromSql = (r: { code: string; error?: string } & Record<string, unknown>): Out =>
  r.code === "OK" ? { status: 200, body: r } : { status: CODE_STATUS[r.code] ?? 500, body: { code: r.code, error: r.error ?? "Failed." } };
const fail = (status: number, code: string, error: string, extra: Record<string, unknown> = {}): Out => ({ status, body: { code, error, ...extra } });
const noDb = () => fail(503, "NO_SERVICE_ROLE", "Server is missing SUPABASE_SERVICE_ROLE_KEY.");
const dbError = (e: { message: string }) => fail(422, "INVALID", e.message.slice(0, 300));

// ───────────────────────────── Store lookups (for the route's staff check) ─────────────────────────────

export async function observationStore(id: string): Promise<string | null> {
  if (!supabaseMode()) return listObservations(DEMO_STORE.id).some((o) => o.id === id) ? DEMO_STORE.id : null;
  const { data } = (await getAdminDb()?.from("observations").select("store_id").eq("id", id).maybeSingle()) ?? {};
  return (data as { store_id?: string } | null)?.store_id ?? null;
}

export async function productStore(id: string): Promise<string | null> {
  if (!supabaseMode()) return listProducts(DEMO_STORE.id).some((p) => p.id === id) ? DEMO_STORE.id : null;
  const { data } = (await getAdminDb()?.from("products").select("store_id").eq("id", id).maybeSingle()) ?? {};
  return (data as { store_id?: string } | null)?.store_id ?? null;
}

// ───────────────────────────── Review ─────────────────────────────

export interface ReviewInput {
  action: "publish" | "reject" | "rescan";
  obsVersion: number;
  draft?: ReviewDraft;
  targetVersion?: number | null;
  reason?: string;
}

const EDIT_KEYS = ["name", "brand", "category", "size", "variant", "shelf", "level"] as const;

export async function reviewObservation(id: string, input: ReviewInput, actor: Actor): Promise<Out> {
  if (!supabaseMode()) {
    const r = memReview({ ...input, observationId: id }, DEMO_STAFF);
    if (!r.ok) return fail(r.status, r.code, r.error, r.failing ? { failing: r.failing } : {});
    return { status: 200, body: { observation: r.observation, product_id: r.product?.id ?? null, is_new: r.isNew ?? false } };
  }
  const db = getAdminDb();
  if (!db) return noDb();
  const base = { p_observation_id: id, p_action: input.action, p_obs_version: input.obsVersion, p_actor: actor.userId, p_actor_label: actor.label };
  if (input.action !== "publish") {
    const { data, error } = await db.rpc("review_observation", { ...base, p_reason: input.reason ?? null });
    return error ? dbError(error) : fromSql(data);
  }
  const d = input.draft;
  if (!d) return fail(422, "INVALID", "Review details are required to publish.", { failing: ["draft"] });
  // The reviewer's confirmations are required server-side too (the UI's checklist is not trusted).
  const failing = [!d.idOk && "Product identity verified", !d.locOk && "Exact shelf location verified", !d.name.trim() && "Product name", !d.shelf && "Shelf", !d.match && "Existing inventory match"].filter(Boolean) as string[];
  if (failing.length) return fail(422, "INVALID", "Server validation failed: " + failing.join("; ").toLowerCase() + ".", { failing });
  const { data: obs } = await db.from("observations").select("candidate_json").eq("id", id).maybeSingle();
  const cand = ((obs as { candidate_json?: Partial<ObservationCandidate> } | null)?.candidate_json ?? {}) as Partial<ObservationCandidate>;
  const edited = EDIT_KEYS.some((k) => (cand[k] || "") !== (d[k] || ""));
  const { data, error } = await db.rpc("review_observation", {
    ...base,
    p_fields: { name: d.name, brand: d.brand, variant: d.variant, size: d.size, category: d.category },
    p_shelf_id: d.shelf,
    p_level: d.level || null,
    p_target_product_id: d.match === "new" ? null : d.match,
    p_target_version: d.match === "new" ? null : (input.targetVersion ?? d.targetVersion),
    p_edited: edited,
  });
  return error ? dbError(error) : fromSql(data);
}

// ───────────────────────────── Product move ─────────────────────────────

export async function moveProduct(id: string, shelfId: string, level: ShelfLevel, expectedVersion: number | undefined, actor: Actor): Promise<Out> {
  if (!supabaseMode()) {
    const r = memMove(id, shelfId, level, expectedVersion, DEMO_STAFF);
    if (!r.ok) return fail(r.status, r.code, r.error, r.failing ? { failing: r.failing } : {});
    return { status: 200, body: { location: r.product.location, version: r.product.version } };
  }
  const db = getAdminDb();
  if (!db) return noDb();
  const { data, error } = await db.rpc("move_product_checked", {
    p_product_id: id, p_shelf_id: shelfId, p_level: level, p_expected_version: expectedVersion ?? null, p_actor: actor.userId, p_actor_label: actor.label,
  });
  if (error) return dbError(error);
  const out = fromSql(data);
  return out.status === 200 ? { status: 200, body: { location: { product_id: id, shelf_id: shelfId, level }, version: data.version } } : out;
}

// ───────────────────────────── Floor plan ─────────────────────────────

const MAPS_NOT_BUILT = () =>
  fail(501, "NOT_IMPLEMENTED", "Saving and publishing floor plans to Supabase is not built yet (the editor's shelf rectangles and landmarks need a table mapping). Memory mode works.");

export async function saveMapDraft(mapId: string, draft: FloorPlan): Promise<Out> {
  if (supabaseMode()) return MAPS_NOT_BUILT();
  const r = memSaveMap(mapId, draft, DEMO_STAFF);
  return r.ok ? { status: 200, body: { maps: r.maps } } : fail(r.status, r.code, r.error);
}

export async function publishMap(mapId: string): Promise<Out> {
  if (supabaseMode()) return MAPS_NOT_BUILT();
  const r = memPublishMap(mapId, DEMO_STAFF);
  return r.ok ? { status: 200, body: { version: r.maps.published.version, event: r.event } } : fail(r.status, r.code, r.error, r.failing ? { failing: r.failing } : {});
}

// ───────────────────────────── Shopper submission ─────────────────────────────

export async function submitShopperObservation(storeId: string, confidence: "High" | "Medium" | "Low", evidence: string, candidate: ObservationCandidate): Promise<Out> {
  if (!supabaseMode()) {
    const r = memSubmit({ storeId, confidence, evidence, candidate });
    return r.ok ? { status: 200, body: { id: r.observation.id, merged: r.merged, message: r.message } } : fail(r.status, r.code, r.error);
  }
  const db = getAdminDb();
  if (!db) return noDb();
  const { data, error } = await db.rpc("submit_shopper_observation", { p_store_id: storeId, p_candidate: candidate, p_confidence: confidence, p_evidence: evidence });
  if (error) return dbError(error);
  const merged = !!data.merged;
  return {
    status: 200,
    body: {
      id: data.observation_id, merged,
      message: merged
        ? "Added as another sighting of an observation already waiting for staff review. No duplicate was created."
        : "Sent for staff review. It is not used for search or directions until approved.",
    },
  };
}
