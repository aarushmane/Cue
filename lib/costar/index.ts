import { fixtureLayers } from "./fixture";
import { liveLayers } from "./live";
import { matterportConfigured } from "./matterport";
import type { DataLayers } from "./types";

export type { DataLayers, CostarProperty, TwinModel, AerialView, FloorPlanImage } from "./types";

/**
 * Real layers (Matterport Model API + models_index.csv + Vexcel + optional CoStar kit) when the Matterport key
 * and token are set; otherwise the labelled fixture. "fixture-property-1" always resolves to the fixture.
 */
export function getDataLayers(): DataLayers {
  return matterportConfigured() ? liveLayers : fixtureLayers;
}
