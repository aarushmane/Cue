// Shared domain types. These mirror docs/contracts.md — change both together.

export type NodeKind = "entrance" | "junction" | "aisle_marker" | "shelf_approach" | "service";

export interface MapNode {
  id: string;
  x: number; // normalized 0..1, left → right on the floor plan
  y: number; // normalized 0..1, top → bottom on the floor plan
  kind: NodeKind;
  label: string; // spoken name, e.g. "the Aisle 2 end sign"
  facingDeg?: number | null; // compass-free heading on the plan (0 = up/north on image), used only when known
}

export interface MapEdge {
  id: string;
  from: string;
  to: string;
  weight: number; // estimated meters; edges are bidirectional
}

export interface Shelf {
  id: string;
  aisle: string; // "1".."4"
  section: string; // "1".."3"
  anchorNodeId: string; // walkable approach node
  // Rectangle on the plan (normalized). Used by the map editor and for left/right side calculation.
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface StoreGraph {
  storeId: string;
  mapId: string;
  mapVersion: number;
  widthM: number; // physical store width, scales normalized x into meters
  heightM: number; // physical store height, scales normalized y into meters
  nodes: MapNode[];
  edges: MapEdge[];
  shelves: Shelf[];
}

export interface Product {
  id: string;
  storeId: string;
  name: string;
  brand: string | null;
  variant: string | null;
  size: string | null;
  aliases: string[];
  /** Staff-facing category, e.g. "Dairy alternatives". Optional so older rows stay valid. */
  category?: string | null;
  /** Optimistic-concurrency version, bumped on every staff edit or move. */
  version?: number;
}

export type ShelfLevel = "top" | "upper" | "middle" | "lower" | "bottom";

export interface ProductLocation {
  productId: string;
  shelfId: string;
  level: ShelfLevel | null;
  verifiedAt: string; // ISO timestamp
  /** Display label of whoever verified this location (staff only; never shopper data). */
  verifiedBy?: string | null;
}

/** A product joined with its current published location. Only these are visible to shoppers. */
export interface PublishedProduct extends Product {
  location: ProductLocation;
  shelf: Pick<Shelf, "id" | "aisle" | "section">;
}

export interface Landmark {
  id: string;
  nodeId: string;
  description: string;
  imageUrl: string | null;
}

export interface RouteStep {
  index: number;
  fromNodeId: string;
  toNodeId: string;
  distanceM: number;
  text: string; // spoken instruction
}

export type RouteResult =
  | {
      status: "OK";
      path: string[];
      destinationShelfId: string;
      totalDistanceM: number;
      steps: RouteStep[];
      mapVersion: number;
    }
  | { status: "ALREADY_THERE"; path: string[]; destinationShelfId: string; steps: RouteStep[]; mapVersion: number }
  | { status: "ROUTE_UNAVAILABLE"; reason: string }
  | { status: "PRODUCT_NOT_PUBLISHED" | "START_NODE_INVALID"; reason: string };

// ───────────────────────────── Review workflow ─────────────────────────────

/**
 * Observation review status. `NEEDS_RESCAN` is the proposed addition from the v4 design handoff
 * (see docs/contracts.md; the database change is drafted, not applied, in docs/proposals/002_needs_rescan.sql).
 */
export type ReviewStatus = "NEEDS_REVIEW" | "ACCEPTED" | "EDITED" | "REJECTED" | "NEEDS_RESCAN";

export type ObservationSource = "shopper" | "ai";

/** What recognition (or a shopper) proposed. Empty strings mean "not detected". */
export interface ObservationCandidate {
  name: string;
  brand: string;
  category: string;
  size: string;
  variant: string;
  aisle: string;
  shelf: string; // shelf id, e.g. "S-A2-2", or "" when no exact shelf
  level: ShelfLevel | "";
}

/** The employee's working copy of an observation while reviewing it. */
export interface ReviewDraft extends ObservationCandidate {
  /** "" = not checked yet, "new" = confirmed new product, otherwise a product id to merge into. */
  match: string;
  targetVersion: number | null;
  idOk: boolean;
  locOk: boolean;
  idReset?: boolean;
  locReset?: boolean;
  obsVersion: number;
}

export interface Observation {
  id: string;
  source: ObservationSource;
  storeId: string;
  at: string;
  confidence: "High" | "Medium" | "Low";
  evidence: string;
  sightings?: number;
  candidate: ObservationCandidate;
  suggestedMatch?: string;
  status: ReviewStatus;
  version: number;
  reviewedBy?: string;
  reviewedById?: string;
  reviewedAt?: string;
  reason?: string;
  productId?: string;
  isNew?: boolean;
  /** Details saved by an employee without publishing. */
  saved?: ReviewDraft;
}

export type ReviewAction = "publish" | "reject" | "rescan";

export type AuditKind = "approve" | "reject" | "rescan" | "move" | "map" | "ai";

/** Audit event as returned by GET /api/audit (snake_case per docs/contracts.md, plus display fields). */
export interface AuditEvent {
  id: string;
  actor_label: string;
  action: AuditKind;
  entity: string;
  entity_id: string | null;
  old_json: { display: string } & Record<string, unknown>;
  new_json: { display: string } & Record<string, unknown>;
  created_at: string;
  summary: string;
  evidence: string;
  original_observation: string | null;
}

// ───────────────────────────── Floor plan editor ─────────────────────────────

/** Editor node kinds. "walk" is a walk point drawn by staff; it is stored as a `junction` in StoreGraph. */
export type PlanNodeKind = "entrance" | "service" | "walk" | "junction" | "shelf_approach" | "aisle_marker";

/** Floor plan in the editor's format. All coordinates are normalized 0..1, origin top-left. */
export interface FloorPlan {
  mapId: string;
  version: number;
  plan: { url: string; name: string; kind: "image" | "pdf" } | null;
  aspect: number; // width / height
  nodes: { id: string; x: number; y: number; kind: PlanNodeKind }[];
  edges: [string, string][];
  shelves: { key: string; id: string; x: number; y: number; w: number; h: number; anchor: string }[];
  landmarks: { id: string; x: number; y: number; label: string; verified: boolean }[];
}

export interface StoreMaps {
  published: FloorPlan;
  draft: FloorPlan | null;
  draftSavedAt: string | null;
}

/** Signed-in employee. The demo uses a single seeded manager until Supabase auth is wired. */
export interface StaffMember {
  id: string;
  label: string;
  stores: string[];
  canPublish: boolean;
}
