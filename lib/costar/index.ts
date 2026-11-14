import { fixtureLayers } from "./fixture";
import type { DataLayers } from "./types";

export type { DataLayers, CostarProperty, TwinModel, AerialView } from "./types";

/**
 * Returns the CoStar/Matterport/Vexcel adapter. Until the event's SDK/API details are known, only the fixture
 * provider exists. TODO(B): implement `costarLayers` in ./costar.ts against the CoStar toolkit (SDK, MCP or
 * OpenAPI), mapping responses into ./types.ts. Key questions are listed in docs/tracks.md.
 */
export function getDataLayers(): DataLayers {
  if (process.env.COSTAR_API_KEY && process.env.MATTERPORT_API_KEY) {
    throw new Error("CoStar keys are set but the real adapter (lib/costar/costar.ts) is not implemented yet.");
  }
  return fixtureLayers;
}
