// Seed data for the v4 review workflow (observations, audit log, demo staff). Mirrors the design handoff
// prototype so the required scenarios in design-handoff/README.md can be demonstrated and tested.
import type { AuditEvent, Observation, ObservationCandidate, StaffMember } from "../types";
import { DEMO_STORE } from "./demo-store";

/** The signed-in demo manager. Replace with Supabase auth via lib/auth/requireStaff.ts. */
export const DEMO_STAFF: StaffMember = { id: "emp-0142", label: "Dana R., Store manager", stores: [DEMO_STORE.id], canPublish: true };

const cand = (
  name: string, brand: string, category: string, size: string, variant: string,
  aisle: string, shelf: string, level: ObservationCandidate["level"],
): ObservationCandidate => ({ name, brand, category, size, variant, aisle, shelf, level });

/**
 * OBS-104 Oatly duplicate of P09 · OBS-105 genuinely new Califia · OBS-101 Jif with size missing ·
 * OBS-102 unidentified, no shelf · OBS-103 Chobani that another employee approves first (409 scenario).
 */
export const SEED_OBSERVATIONS: Observation[] = (
  [
    { id: "OBS-104", source: "shopper", at: "2026-11-14T07:48:00Z", confidence: "Medium", suggestedMatch: "P09",
      evidence: "2 shopper sightings from the Aisle 2 approach (N13). Text only, no images.",
      candidate: cand("Oatmilk", "Oatly", "Dairy alternatives", "64 oz", "original", "2", "S-A2-2", "middle") },
    { id: "OBS-105", source: "shopper", at: "2026-11-14T07:52:00Z", confidence: "Medium",
      evidence: "1 shopper sighting from N13. Not listed in inventory.",
      candidate: cand("Oat Milk Barista Blend", "Califia Farms", "Dairy alternatives", "32 oz", "barista", "2", "S-A2-2", "upper") },
    { id: "OBS-101", source: "ai", at: "2026-11-14T08:05:00Z", confidence: "Medium",
      evidence: "shelf_A3_2_0805.jpg (demo). Logo visible, size label hidden by price tag.",
      candidate: cand("Creamy Peanut Butter", "Jif", "Pantry", "", "", "3", "S-A3-2", "middle") },
    { id: "OBS-102", source: "ai", at: "2026-11-14T08:05:00Z", confidence: "Low",
      evidence: 'shelf_A3_2_0805.jpg (demo). Label turned away. Location estimated as "near Aisle 3", no shelf.',
      candidate: cand("", "", "", "", "", "", "", "") },
    { id: "OBS-103", source: "shopper", at: "2026-11-14T07:30:00Z", confidence: "High", suggestedMatch: "P11",
      evidence: "3 shopper sightings from N14, one level lower than listed.",
      candidate: cand("Greek Yogurt", "Chobani", "Dairy", "32 oz", "plain", "2", "S-A2-3", "lower") },
  ] as const satisfies readonly Omit<Observation, "storeId" | "status" | "version">[]
).map((o) => ({ ...o, candidate: { ...o.candidate }, storeId: DEMO_STORE.id, status: "NEEDS_REVIEW" as const, version: 1 }));

/**
 * Demo concurrency: when anyone submits a review for one of these observations, the server first records
 * this other employee's approval, so the request fails with 409 like a real race would.
 */
export const DEMO_OTHER_REVIEWER: Record<string, { by: string; byId: string; at: string }> = {
  "OBS-103": { by: "Marcus T., Staff", byId: "emp-0077", at: "2026-11-14T08:12:00Z" },
};

export const SEED_AUDIT: AuditEvent[] = [
  { id: "e3", actor_label: "Shopper sightings and AI vision", action: "ai", entity: "observation", entity_id: null,
    created_at: "2026-11-14T08:05:00Z", summary: "5 observations awaiting review",
    old_json: { display: "—" }, new_json: { display: "5 observations, NEEDS_REVIEW" }, evidence: "shelf_A3_2_0805.jpg (demo)", original_observation: null },
  { id: "e2", actor_label: "Dana R., Store manager", action: "move", entity: "product", entity_id: "P09",
    created_at: "2026-11-13T21:12:00Z", summary: "Oat Milk moved to Aisle 2, Section 2",
    old_json: { display: "Aisle 2 · Section 1 · middle" }, new_json: { display: "Aisle 2 · Section 2 · middle" }, evidence: "shelf_A2_2_2110.jpg (demo)", original_observation: null },
  { id: "e1", actor_label: "Marcus T., Staff", action: "map", entity: "store_map", entity_id: "map-demo-v1",
    created_at: "2026-11-13T17:40:00Z", summary: "Store map updated to v1",
    old_json: { display: "Draft" }, new_json: { display: "Published v1" }, evidence: "floorplan.svg", original_observation: null },
];

/** Demo recognition samples for the shopper observation scan (vision service not connected on this surface). */
export const DEMO_RECOGNITION: { name: string; brand: string; size: string; confidence: Observation["confidence"]; evidence: string; candidate: ObservationCandidate }[] = [
  { name: "Vanilla Skyr", brand: "Siggi's", size: "5.3 oz", confidence: "High",
    evidence: "Demo recognition: brand and flavor legible on the cup. No image kept.",
    candidate: cand("Vanilla Skyr", "Siggi's", "Dairy", "5.3 oz", "vanilla", "2", "S-A2-3", "") },
  { name: "Oat Milk Barista Blend", brand: "Califia Farms", size: "32 oz", confidence: "Medium",
    evidence: "Demo recognition: carton front visible. No image kept.",
    candidate: cand("Oat Milk Barista Blend", "Califia Farms", "Dairy alternatives", "32 oz", "barista", "2", "S-A2-2", "upper") },
];
