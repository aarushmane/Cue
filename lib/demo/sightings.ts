"use server";
// DEMO ADAPTER for the shopper-sightings queue (adaptive inventory, lib/inventory/store.ts).
// Same rules as lib/demo/adapter.ts: memory mode only, the signed-in employee is the seeded DEMO_STAFF, and when
// Supabase is configured these refuse with 503. Real clients use the staff-authenticated routes instead:
//   listSightingsDemo   → GET  /api/inventory + GET /api/inventory/suggestions
//   reviewSightingDemo  → POST /api/inventory/suggestions/:id
import { z } from "zod";
import { listInventory, listSuggestions, reviewSuggestion, suggestionStore, topShelf, type InventoryRow, type Suggestion } from "../inventory/store";
import { recordAudit } from "../db/demoState";
import { DEMO_STAFF } from "../seed/demo-review";
import { DEMO_STORE } from "../seed/demo-store";
import { LEVELS } from "../review/format";
import type { DemoFail, DemoResult } from "./types";
import type { ShelfLevel } from "../types";

const STORE = DEMO_STORE.id;

const NOT_CONNECTED: DemoFail = {
  ok: false, status: 503, code: "BACKEND_NOT_CONNECTED",
  error: "Supabase is configured, so sightings are reviewed through the signed-in staff API. Nothing was changed.",
};
const backendConnected = () => !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

export interface SightingsSnapshot {
  queue: Suggestion[];
  /** Published items shoppers' cameras looked for but did not see on recent scans. */
  unseen: InventoryRow[];
  lastSeenCount: number;
  total: number;
}

async function snapshot(): Promise<SightingsSnapshot> {
  const [queue, items] = await Promise.all([listSuggestions(STORE, ["PENDING"]), listInventory(STORE)]);
  return {
    queue,
    unseen: items.filter((i) => i.miss_count > 0).sort((a, b) => b.miss_count - a.miss_count),
    lastSeenCount: items.filter((i) => i.last_seen_at).length,
    total: items.length,
  };
}

export async function listSightingsDemo(): Promise<DemoResult<{ sightings: SightingsSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  return { ok: true, sightings: await snapshot() };
}

const Text = z.string().trim().max(120).nullable().optional();
const Review = z.object({
  id: z.string().min(1).max(80),
  action: z.enum(["approve", "reject"]),
  shelfId: z.string().max(40).optional(),
  level: z.enum(LEVELS as [ShelfLevel, ...ShelfLevel[]]).nullable().optional(),
  edits: z.object({ name: Text, brand: Text, variant: Text, size: Text, category: Text }).optional(),
});

const KIND_TXT = { NEW_PRODUCT: "new item", MOVED: "move", MISSING: "possibly gone" } as const;
const titleOf = (p: { brand: string | null; name: string; size: string | null }) => [p.brand, p.name, p.size].filter(Boolean).join(" ");
const shelfTxt = (id: string | null | undefined) => (id ? id.replace(/^S-A(\w+)-(\w+)$/, "Aisle $1, Section $2") : "—");

export async function reviewSightingDemo(input: unknown): Promise<DemoResult<{ message: string; sightings: SightingsSnapshot }>> {
  if (backendConnected()) return NOT_CONNECTED;
  const parsed = Review.safeParse(input);
  if (!parsed.success) return { ok: false, status: 422, code: "INVALID", error: "The review request was malformed. Nothing was changed." };
  const { id, action, shelfId, level, edits } = parsed.data;
  if ((await suggestionStore(id)) !== STORE) return { ok: false, status: 404, code: "NOT_FOUND", error: "Sighting not found." };

  const cleanEdits = edits ? Object.fromEntries(Object.entries(edits).map(([k, v]) => [k, v || null])) : undefined;
  const r = await reviewSuggestion(id, action, { shelf_id: shelfId, level: level ?? null, edits: cleanEdits }, { userId: null, label: DEMO_STAFF.label });
  if (!r.ok) return { ok: false, status: r.status, code: r.status === 409 ? "ALREADY_REVIEWED" : "INVALID", error: r.error, };

  const s = r.suggestion;
  const p = { ...s.proposed, ...cleanEdits } as Suggestion["proposed"];
  const shelf = shelfId ?? topShelf(s.shelf_counts);
  const what = `${titleOf(p) || "Item"} (${KIND_TXT[s.kind]})`;
  recordAudit({
    actor_label: `${DEMO_STAFF.label} · ${DEMO_STAFF.id}`,
    action: action === "approve" ? (s.kind === "MOVED" ? "move" : "approve") : "reject",
    entity: "product", entity_id: r.product_id,
    summary: `Shopper sighting ${action === "approve" ? "approved" : "rejected"}: ${what}`,
    old_json: { display: s.kind === "NEW_PRODUCT" ? "— (not listed)" : "Listed" },
    new_json: {
      display: action === "reject" ? "Unchanged" : s.kind === "MISSING" ? "Removed from shopper search" : `${shelfTxt(shelf)}${level ? `, ${level} shelf` : ""}`,
    },
    evidence: `${s.sighting_count} shopper camera sighting${s.sighting_count === 1 ? "" : "s"}. ${s.evidence[0] ?? ""}`.trim(),
    original_observation: null,
  });

  const message = action === "reject"
    ? `Rejected. ${titleOf(p) || "The item"} is unchanged for shoppers.`
    : s.kind === "NEW_PRODUCT" ? `Added ${titleOf(p)} at ${shelfTxt(shelf)}. Shoppers can find it now.`
    : s.kind === "MOVED" ? `Moved ${titleOf(p)} to ${shelfTxt(shelf)}. Directions use the new spot now.`
    : `Removed ${titleOf(p)} from shopper search.`;
  return { ok: true, message, sightings: await snapshot() };
}
