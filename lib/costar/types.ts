// Shapes our code needs from the CoStar / Matterport / Vexcel layers. The real adapter maps their SDK
// responses into these; nothing outside lib/costar should depend on vendor response shapes.
import type { TwinSweep, WallSegment } from "../twin/sweepsToGraph";

export interface CostarProperty {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  propertyType: string | null; // e.g. "Retail"
  tenants: string[];
  matterportModelId: string | null;
  /** Raw (trimmed) record from the CoStar data kit, when the kit is configured. */
  costarRecord?: Record<string, unknown> | null;
}

/** A floor-plan render and where it sits in floor meters. origin = bottom-left corner (Matterport's convention). */
export interface FloorPlanImage {
  url: string;
  width: number;
  height: number;
  resolution: number; // pixels per meter
  originX: number;
  originY: number;
}

export interface TwinModel {
  modelId: string;
  floors: { id: string; label: string }[];
  sweeps: TwinSweep[];
  panoramas: { sweepId: string; imageUrl: string }[]; // used as landmark reference images
  floorPlanImageUrl: string | null;
  floorPlans?: FloorPlanImage[];
  /** Walls per floor id, in the same (y-down) frame as the sweeps. */
  walls?: Record<string, WallSegment[]>;
  /** Room label per sweep id (Matterport's room classification), e.g. "Lobby". */
  rooms?: Record<string, string>;
}

export interface AerialView {
  /** Ortho image as a data URL. Server-side only: never put this into model context or API responses. */
  imageDataUrl: string | null;
  capturedAt: string | null;
  /** Ground size the image covers, in meters per side (north-up). */
  extentM: number | null;
  notes: string;
}

export interface DataLayers {
  readonly source: "costar" | "fixture";
  lookupProperty(propertyId: string): Promise<CostarProperty | null>;
  getTwin(modelId: string): Promise<TwinModel | null>;
  getAerial(lat: number, lng: number): Promise<AerialView | null>;
}
