// Wayfinding inside a Matterport space: find an item, plan an obstacle-free route to it, and describe that route
// as legs and floor arrows that a renderer can draw over the 3D tour.
//
// FRAME: every position here is in the Matterport Model API frame — metres, right-handed, z up, the same frame as
// `panoLocations.position` / `locations.position` from api.matterport.com. Planning happens on the floor plane (x, y);
// z only places arrows and items in 3D. The Showcase SDK uses a different (y-up) frame: convert on the client with
// `mpSdk.Conversion.basisChange(p, mpSdk.Conversion.TransformType.Coordinates.TO_SDK)`.
//
// HEADINGS: degrees on the floor plane, 0° = +x, counter-clockwise positive (seen from above), range (-180, 180].

import type { WalkGrid } from "./walkable";

export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

/** A Matterport scan point ("sweep"). The scanner stood here, so it is known walkable floor. */
export interface Waypoint {
  id: string;
  /** Floor point under the scanner (anchor position). */
  position: Vec3;
  /** Panorama camera centre, when known (≈ 1.35 m above `position`). Needed to turn photo detections into rays. */
  camera?: Vec3;
  /** Panorama orientation (pano-local → model frame), when known. Needed to turn photo detections into rays. */
  rotation?: Quat;
  floorId: string | null;
  /** Scan points the scanner moved between. Trusted as walkable and obstacle-free. */
  neighbors: string[];
  label?: string;
  /** "photo" = a real scan point with a 360° photo; "aisle" = a standing point added from the mesh (no photo). */
  kind?: "photo" | "aisle";
}

/** Something a visitor may ask for: a product, a shelf, a fixture. */
export interface SceneItem {
  id: string;
  name: string;
  aliases?: string[];
  brand?: string | null;
  category?: string | null;
  /** Where the item is (on the shelf face, not the floor). */
  position: Vec3;
  floorId?: string | null;
  source: "staff" | "inventory" | "vision";
  /** 0..1. Vision estimates carry their triangulation quality here. */
  confidence?: number;
}

/** Things a route must not pass through, on the floor plane. Boxes are shelves/fixtures; walls are line segments. */
export type Obstacle =
  | { kind: "box"; id?: string; label?: string; minX: number; minY: number; maxX: number; maxY: number; floorId?: string | null }
  | { kind: "wall"; id?: string; ax: number; ay: number; bx: number; by: number; floorId?: string | null };

export interface WayfindingScene {
  modelId: string;
  waypoints: Waypoint[];
  items: SceneItem[];
  obstacles: Obstacle[];
  /** Scan mesh triangles (flat xyz list), when loaded: lets one photo detection become a 3D point. */
  surfaces?: Float32Array;
  /** Walkable floor grid derived from the mesh, when loaded: planner-added edges must stay on it. */
  walk?: WalkGrid;
}

/** Where the visitor is: on a scan point (what the Showcase SDK reports) or at a free position. */
export type StartPoint = { sweepId: string } | { position: Vec3; floorId?: string | null };

export type Turn = "straight" | "slight_left" | "slight_right" | "left" | "right" | "around";

export interface RouteLeg {
  index: number;
  from: Vec3;
  to: Vec3;
  /** Waypoint id at the end of the leg (null for the final approach to a free stand point). */
  toWaypointId: string | null;
  distanceM: number;
  headingDeg: number;
  /** Turn relative to the previous leg; null for the first leg (the visitor's facing is unknown to the planner). */
  turn: Turn | null;
  text: string;
}

/** A floor arrow: where to draw it and which way it points. */
export interface RouteArrow {
  position: Vec3;
  headingDeg: number;
  /** Distance along the route from the start. */
  atM: number;
}

export type RoutePlan =
  | {
      status: "OK" | "ALREADY_THERE";
      item: SceneItem;
      /** Scan point ids walked, start → approach. Showcase can step through these with `Sweep.moveTo`. */
      waypointIds: string[];
      /** Route on the floor, start → stand point, after obstacle-checked smoothing. */
      polyline: Vec3[];
      /** Where to stand, and which way to face to see the item. */
      standPoint: Vec3;
      facingDeg: number;
      legs: RouteLeg[];
      arrows: RouteArrow[];
      totalDistanceM: number;
      warnings: string[];
    }
  | { status: "ITEM_NOT_FOUND" | "START_INVALID" | "NO_ROUTE" | "NO_APPROACH"; reason: string };
