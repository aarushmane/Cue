// Shared domain types. These mirror docs/contracts.md — change both together.

export type NodeKind = "entrance" | "junction" | "aisle_marker" | "shelf_approach" | "service" | "outdoor";

export type NodeSource = "manual" | "matterport" | "vexcel";

export interface MapNode {
  id: string;
  x: number; // normalized 0..1, left → right on the floor plan
  y: number; // normalized 0..1, top → bottom on the floor plan
  kind: NodeKind;
  label: string; // spoken name, e.g. "the Aisle 2 end sign"
  facingDeg?: number | null; // compass-free heading on the plan (0 = up/north on image), used only when known
  source?: NodeSource; // default "manual"
  sweepId?: string | null; // Matterport sweep this node was imported from
}

export type ConfidenceState = "CONFIRMED" | "LIKELY" | "UNKNOWN";

export interface LocalizeResult {
  confidence_state: ConfidenceState;
  selected_node_id: string | null;
  candidate_node_ids: string[];
  landmark_id: string | null;
  evidence: string;
}

export type NavigationState =
  | "SEARCHING"
  | "DESTINATION_SELECTED"
  | "LOCATING"
  | "ROUTING"
  | "GUIDING"
  | "ARRIVED"
  | "NEEDS_HELP";

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
  category?: string | null; // product type, e.g. "plant-based milk"
}

export type ShelfLevel = "top" | "upper" | "middle" | "lower" | "bottom";

export interface ProductLocation {
  productId: string;
  shelfId: string;
  level: ShelfLevel | null;
  verifiedAt: string; // ISO timestamp
  lastSeenAt?: string | null; // last time a shopper's camera saw it at this location
  missCount?: number; // consecutive scans that looked at this shelf without seeing it
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
