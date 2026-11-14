// Staff reads behind GET /api/audit, GET /api/observations, GET /api/maps and GET /api/staff/snapshot (issue #6, 4F).
// Memory mode returns the in-memory demo state; Supabase mode reads with the service role AFTER the route's
// requireStaff check for the store, and maps rows to the same shapes the manager screens use (lib/types.ts).
// The row mappers are pure and unit-tested.
import { getAdminDb } from "../db/admin";
import { getMaps, listAudit, listObservations, listProducts } from "../db/demoState";
import { SupabaseRepo } from "../db/repo";
import type { StaffSnapshot } from "../demo/types";
import { DEMO_STAFF } from "../seed/demo-review";
import { DEMO_STORE } from "../seed/demo-store";
import type { AuditEvent, AuditKind, Observation, ObservationCandidate, PublishedProduct, ReviewStatus, ShelfLevel, StoreMaps } from "../types";
import { readStoreMaps } from "./maps";
import { supabaseMode, type Actor } from "./service";

// ───────────────────────────── Row mappers (pure) ─────────────────────────────

export interface AuditRow {
  id: number | string; actor_label: string | null; action: string; entity: string; entity_id: string | null;
  old_json: Record<string, unknown> | null; new_json: Record<string, unknown> | null; created_at: string;
}

const KIND: Record<string, AuditKind> = {
  "observation.approve": "approve", "suggestion.approve": "approve",
  "observation.reject": "reject", "suggestion.reject": "reject",
  "observation.rescan": "rescan",
  "location.move": "move", "location.publish": "move", "location.retire": "move",
  "map.publish": "map",
};

/** "display" when the writer set one; otherwise a short "key: value" summary of the scalar fields. */
export function displayOf(j: Record<string, unknown> | null): string {
  if (!j) return "—";
  if (typeof j.display === "string") return j.display;
  const parts = Object.entries(j)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .slice(0, 4)
    .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`);
  return parts.length ? parts.join(" · ") : "—";
}

function summaryOf(r: AuditRow): string {
  const id = r.entity_id ?? "";
  const n = r.new_json ?? {};
  switch (r.action) {
    case "observation.approve": return `${id} approved${n.new_product ? " as a new product" : ""}`;
    case "observation.reject": return `${id} rejected`;
    case "observation.rescan": return `${id} sent back for rescan`;
    case "observation.submit": return `Shopper sighting ${id} sent for review`;
    case "observation.sighting": return `Another shopper sighting of ${id}`;
    case "location.move": return `Product ${n.product_id ?? id} moved${n.shelf_id ? ` to ${n.shelf_id}` : ""}`;
    case "location.publish": return `Location published for ${n.product_id ?? id}`;
    case "location.retire": return `Location retired for ${n.product_id ?? id}`;
    case "map.publish": return `Floor plan v${n.version ?? "?"} published`;
    case "suggestion.approve": return `Inventory suggestion ${id} approved`;
    case "suggestion.reject": return `Inventory suggestion ${id} rejected`;
    default: return `${r.action} ${id}`.trim();
  }
}

export function auditFromRow(r: AuditRow): AuditEvent {
  const n = r.new_json ?? {};
  const evidence = [n.reason, n.note, n.evidence].find((v) => typeof v === "string" && v) as string | undefined;
  return {
    id: String(r.id),
    actor_label: r.actor_label ?? "system",
    action: KIND[r.action] ?? "ai",
    entity: r.entity,
    entity_id: r.entity_id,
    old_json: { ...(r.old_json ?? {}), display: displayOf(r.old_json) },
    new_json: { ...n, display: displayOf(r.new_json) },
    created_at: r.created_at,
    summary: summaryOf(r),
    evidence: evidence ?? "—",
    original_observation: r.entity === "observation" ? r.entity_id : null,
  };
}

export interface ObservationRow {
  id: string; store_id: string; source: string; candidate_json: Partial<ObservationCandidate> | null; review_status: string;
  version: number; sightings: number | null; evidence: string | null; confidence: string | null; reviewed_by: string | null;
  reviewed_at: string | null; product_id: string | null; review_reason: string | null; created_at: string;
}

const LEVEL_SET = new Set(["top", "upper", "middle", "lower", "bottom"]);

export function observationFromRow(r: ObservationRow): Observation {
  const c = r.candidate_json ?? {};
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const level = str(c.level);
  return {
    id: r.id,
    source: r.source === "shopper" ? "shopper" : "ai",
    storeId: r.store_id,
    at: r.created_at,
    confidence: r.confidence === "High" || r.confidence === "Low" ? r.confidence : "Medium",
    evidence: r.evidence ?? "",
    sightings: r.sightings ?? 1,
    candidate: {
      name: str(c.name), brand: str(c.brand), category: str(c.category), size: str(c.size), variant: str(c.variant),
      aisle: str(c.aisle), shelf: str(c.shelf), level: (LEVEL_SET.has(level) ? level : "") as ShelfLevel | "",
    },
    status: r.review_status as ReviewStatus,
    version: r.version,
    ...(r.reviewed_by ? { reviewedById: r.reviewed_by } : {}),
    ...(r.reviewed_at ? { reviewedAt: r.reviewed_at } : {}),
    ...(r.review_reason ? { reason: r.review_reason } : {}),
    ...(r.product_id ? { productId: r.product_id } : {}),
  };
}

// ───────────────────────────── Reads ─────────────────────────────

const STATUSES = new Set<ReviewStatus>(["NEEDS_REVIEW", "ACCEPTED", "EDITED", "REJECTED", "NEEDS_RESCAN"]);

/** Parse `?status=A,B`: null = all statuses; throws on an unknown one (the route answers 400). */
export function parseStatuses(param: string | null): ReviewStatus[] | null {
  if (!param) return null;
  const list = param.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  for (const s of list) if (!STATUSES.has(s as ReviewStatus)) throw new Error(`Unknown status ${s}`);
  return list as ReviewStatus[];
}

function db() {
  const d = getAdminDb();
  if (!d) throw new Error("Server is missing SUPABASE_SERVICE_ROLE_KEY.");
  return d;
}

function must<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

export async function readAudit(storeId: string, limit = 200): Promise<AuditEvent[]> {
  if (!supabaseMode()) return listAudit(storeId).slice(0, limit);
  const rows = must(await db().from("audit_events")
    .select("id, actor_label, action, entity, entity_id, old_json, new_json, created_at")
    .eq("store_id", storeId).order("created_at", { ascending: false }).limit(limit)) as AuditRow[];
  return rows.map(auditFromRow);
}

export async function readObservations(storeId: string, statuses: ReviewStatus[] | null): Promise<Observation[]> {
  if (!supabaseMode()) {
    const all = listObservations(storeId);
    return statuses ? all.filter((o) => statuses.includes(o.status)) : all;
  }
  let q = db().from("observations")
    .select("id, store_id, source, candidate_json, review_status, version, sightings, evidence, confidence, reviewed_by, reviewed_at, product_id, review_reason, created_at")
    .eq("store_id", storeId).order("created_at", { ascending: false }).limit(500);
  if (statuses) q = q.in("review_status", statuses);
  return (must(await q) as ObservationRow[]).map(observationFromRow);
}

export async function readMaps(storeId: string): Promise<StoreMaps | null> {
  if (!supabaseMode()) return getMaps(storeId);
  const m = await readStoreMaps(db(), storeId);
  return m ? { published: m.published, draft: m.draft, draftSavedAt: m.draftSavedAt } : null;
}

export async function readProducts(storeId: string): Promise<PublishedProduct[]> {
  if (!supabaseMode()) return listProducts(storeId);
  return new SupabaseRepo(db()).listPublishedProducts(storeId);
}

/** Stores the signed-in employee works at (Supabase), or the demo store (memory mode). */
export async function staffStores(actor: Actor): Promise<{ id: string; name: string }[]> {
  if (!supabaseMode()) return [{ id: DEMO_STORE.id, name: DEMO_STORE.name }];
  if (!actor.userId) return [];
  const rows = must(await db().from("store_staff").select("store_id, stores!inner(name)").eq("user_id", actor.userId)) as unknown as
    { store_id: string; stores: { name: string } }[];
  return rows.map((r) => ({ id: r.store_id, name: r.stores.name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Everything the manager screens read, for one store the caller is already authorized for. */
export async function readSnapshot(store: { id: string; name: string }, actor: Actor): Promise<StaffSnapshot | null> {
  const [products, observations, audit, maps] = await Promise.all([
    readProducts(store.id), readObservations(store.id, null), readAudit(store.id), readMaps(store.id),
  ]);
  if (!maps) return null;
  const staff = supabaseMode() ? { id: actor.userId ?? "", label: actor.label } : { id: DEMO_STAFF.id, label: DEMO_STAFF.label };
  return { storeId: store.id, storeName: store.name, staff, products, observations, audit, maps };
}
