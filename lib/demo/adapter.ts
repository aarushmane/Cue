"use server";
// ─────────────────────────────────────────────────────────────────────────────
// DEMO ADAPTER — the demo-only Server Functions that have no API route yet.
//
// They call the in-memory demo backend in lib/db/demoState.ts (the same process-wide state that MemoryRepo serves
// to shopper search and that the staff API routes write in memory mode). They are NOT durable and there is NO
// real authentication: the employee is the seeded DEMO_STAFF. Screens that use them keep a "Demo action" label.
//   getStaffSnapshotDemo  → reads for the manager screens in memory mode (Supabase mode: GET /api/staff/snapshot)
//   saveReviewDraftDemo   → "Save details" on an observation (no route in the contract yet)
//   resetDemoDataDemo     → More → Reset demo data
// Staff writes (review, product moves, floor plan) and shopper submissions use the real API routes now
// (lib/staff/client.ts, components/shopper/ObservationScan.tsx).
//
// When Supabase is configured, writing to demo memory would silently diverge from the real database, so these
// functions refuse with 503 instead of pretending to succeed.
// ─────────────────────────────────────────────────────────────────────────────
import { getMaps, listAudit, listObservations, listProducts, resetDemo, saveDraft } from "../db/demoState";
import { DEMO_STAFF } from "../seed/demo-review";
import { DEMO_STORE } from "../seed/demo-store";
import type { DemoFail, DemoResult, StaffSnapshot } from "./types";
import { Draft } from "./schemas";

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

/** "Save details": keep corrections on the observation without publishing. */
export async function saveReviewDraftDemo(id: string, draft: unknown): Promise<DemoResult<{ snapshot: StaffSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  const d = Draft.safeParse(draft);
  if (!d.success || typeof id !== "string") return invalid("The details were malformed. Nothing was saved.");
  const r = saveDraft(id, d.data, DEMO_STAFF);
  return r.ok ? withSnapshot({ ok: true as const }) : withSnapshot(r);
}

export async function resetDemoDataDemo(): Promise<DemoResult<{ snapshot: StaffSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  resetDemo();
  return { ok: true, snapshot: snapshot() };
}
