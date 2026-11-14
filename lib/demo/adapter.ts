"use server";
// ─────────────────────────────────────────────────────────────────────────────
// DEMO ADAPTER — stands in for staff/shopper API routes that are not built yet.
//
// These Server Functions call the in-memory demo backend in lib/db/demoState.ts (the same process-wide state
// that MemoryRepo serves to GET /api/products and POST /api/routes, so an approval here is visible to shopper
// search on the next request). They are NOT durable and there is NO real authentication: the signed-in
// employee is the seeded DEMO_STAFF. Every screen that uses them keeps a "Demo action" label.
//
// Each function mirrors a contract in docs/contracts.md and returns the same { status, code, error } shape.
// The real routes now exist (lib/staff/service.ts); the screens stay on these until the app has a staff sign-in
// that can send a bearer token:
//   reviewObservationDemo   → POST /api/observations/:id/review
//   moveProductDemo         → PATCH /api/products/:id/location
//   saveMapDraftDemo        → PUT /api/maps/:id/graph
//   publishMapDemo          → POST /api/maps/:id/publish
//   submitShopperObservationDemo → POST /api/observations (no staff token needed: could switch now)
//   getStaffSnapshotDemo    → GET /api/audit + observation/product/map reads (not built)
//
// When Supabase is configured, the shopper surface reads the real database, so writing to demo memory would
// silently diverge. In that case these functions refuse with 503 instead of pretending to succeed.
// ─────────────────────────────────────────────────────────────────────────────
import {
  getMaps, listAudit, listObservations, listProducts, moveProduct, publishMap, resetDemo, reviewObservation, saveDraft,
  saveMapDraft, submitShopperObservation,
} from "../db/demoState";
import { DEMO_STAFF } from "../seed/demo-review";
import { DEMO_STORE } from "../seed/demo-store";
import type { DemoFail, DemoResult, StaffSnapshot } from "./types";
import type { FloorPlan, Observation } from "../types";
import { Draft, Level, Plan, ReviewReq, Submission } from "./schemas";

const STORE = DEMO_STORE.id;

function backendConnected(): boolean {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

const NOT_CONNECTED: DemoFail = {
  ok: false, status: 503, code: "BACKEND_NOT_CONNECTED",
  error: "Supabase is configured, but the staff API routes for this action are not built yet. Nothing was changed.",
};

function snapshot(): StaffSnapshot {
  return {
    storeId: STORE,
    storeName: DEMO_STORE.name,
    staff: { id: DEMO_STAFF.id, label: DEMO_STAFF.label },
    products: listProducts(STORE),
    observations: listObservations(STORE),
    audit: listAudit(STORE),
    maps: getMaps(STORE)!,
  };
}

const withSnapshot = <T extends object>(r: T): T & { snapshot: StaffSnapshot } => ({ ...r, snapshot: snapshot() });

const invalid = (error: string): DemoFail => ({ ok: false, status: 422, code: "INVALID", error });

// ───────────────────────────── Staff ─────────────────────────────

export async function getStaffSnapshotDemo(): Promise<DemoResult<{ snapshot: StaffSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  return { ok: true, snapshot: snapshot() };
}

/** Stands in for POST /api/observations/:id/review (publish | reject | rescan). */
export async function reviewObservationDemo(
  input: unknown, opts: { simulateFailure?: boolean } = {},
): Promise<DemoResult<{ observation: Observation; isNew?: boolean; productId?: string; snapshot: StaffSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  const parsed = ReviewReq.safeParse(input);
  if (!parsed.success) return invalid("The review request was malformed. Nothing was changed.");
  if (opts.simulateFailure) {
    // Demo toggle (More → Demo controls): fail before anything is written, like a dropped request would.
    return { ok: false, status: 500, code: "FAILED", error: "The request did not complete (simulated failure). Nothing was changed. You can try again." };
  }
  const r = reviewObservation(parsed.data, DEMO_STAFF);
  if (!r.ok) return withSnapshot(r);
  return withSnapshot({ ok: true as const, observation: r.observation, isNew: r.isNew, productId: r.product?.id });
}

/** "Save details": keep corrections on the observation without publishing. */
export async function saveReviewDraftDemo(id: string, draft: unknown): Promise<DemoResult<{ snapshot: StaffSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  const d = Draft.safeParse(draft);
  if (!d.success || typeof id !== "string") return invalid("The details were malformed. Nothing was saved.");
  const r = saveDraft(id, d.data, DEMO_STAFF);
  return r.ok ? withSnapshot({ ok: true as const }) : withSnapshot(r);
}

/** Stands in for PATCH /api/products/:id/location (move_product). */
export async function moveProductDemo(
  productId: string, shelfId: string, level: string, expectedVersion: number,
): Promise<DemoResult<{ snapshot: StaffSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  const lv = Level.safeParse(level);
  if (!lv.success || typeof productId !== "string" || typeof shelfId !== "string" || !Number.isInteger(expectedVersion)) {
    return invalid("Choose a shelf and level.");
  }
  const r = moveProduct(productId, shelfId, lv.data, expectedVersion, DEMO_STAFF);
  return r.ok ? withSnapshot({ ok: true as const }) : withSnapshot(r);
}

/** Stands in for PUT /api/maps/:id/graph (drafts only). */
export async function saveMapDraftDemo(mapId: string, draft: unknown): Promise<DemoResult<{ snapshot: StaffSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  const d = Plan.safeParse(draft);
  if (!d.success) return invalid("The floor plan draft was malformed. Nothing was saved.");
  const r = saveMapDraft(mapId, d.data as FloorPlan, DEMO_STAFF);
  return r.ok ? withSnapshot({ ok: true as const }) : withSnapshot(r);
}

/** Saves the draft, then publishes it as the next version (server re-runs mapChecks). */
export async function publishMapDemo(mapId: string, draft: unknown): Promise<DemoResult<{ version: number; snapshot: StaffSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  const d = Plan.safeParse(draft);
  if (!d.success) return invalid("The floor plan draft was malformed. Nothing was published.");
  const saved = saveMapDraft(mapId, d.data as FloorPlan, DEMO_STAFF);
  if (!saved.ok) return withSnapshot(saved);
  const r = publishMap(mapId, DEMO_STAFF);
  return r.ok ? withSnapshot({ ok: true as const, version: r.maps.published.version }) : withSnapshot(r);
}

export async function resetDemoDataDemo(): Promise<DemoResult<{ snapshot: StaffSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  resetDemo();
  return { ok: true, snapshot: snapshot() };
}

// ───────────────────────────── Shopper ─────────────────────────────


/**
 * A consented shopper observation. Structured text only: no image or video is accepted here.
 * Requires consent === "allowed" in the request; anything else is refused and nothing is stored.
 */
export async function submitShopperObservationDemo(input: unknown): Promise<DemoResult<{ id: string; merged: boolean; message: string }>> {
  if (backendConnected()) return NOT_CONNECTED;
  const parsed = Submission.safeParse(input);
  if (!parsed.success) {
    return { ok: false, status: 403, code: "NO_CONSENT", error: "Product contributions are not allowed, so nothing was sent." };
  }
  const { confidence, evidence, candidate } = parsed.data;
  const r = submitShopperObservation({ storeId: STORE, confidence, evidence, candidate });
  return r.ok ? { ok: true, id: r.observation.id, merged: r.merged, message: r.message } : r;
}
