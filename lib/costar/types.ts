// Shapes our code needs from the CoStar / Matterport / Vexcel layers. The real adapter maps their SDK
// responses into these; nothing outside lib/costar should depend on vendor response shapes.
import type { TwinSweep } from "../twin/sweepsToGraph";

export interface CostarProperty {
  id: string;
  name: string;
  address: string;
  latitude: number;
  longitude: number;
  propertyType: string | null; // e.g. "Retail"
  tenants: string[];
  matterportModelId: string | null;
}

export interface TwinModel {
  modelId: string;
  floors: { id: string; label: string }[];
  sweeps: TwinSweep[];
  panoramas: { sweepId: string; imageUrl: string }[]; // used as landmark reference images
  floorPlanImageUrl: string | null;
}

export interface AerialView {
  imageUrl: string;
  capturedAt: string | null;
  /** Approximate entrance point(s) the provider or the agent identified, in lat/lng. Staff confirm. */
  notes: string;
}

export interface DataLayers {
  readonly source: "costar" | "fixture";
  lookupProperty(propertyId: string): Promise<CostarProperty | null>;
  getTwin(modelId: string): Promise<TwinModel | null>;
  getAerial(lat: number, lng: number): Promise<AerialView | null>;
}
