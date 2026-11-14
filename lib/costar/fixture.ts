// FIXTURE data so the onboarding agent and twin import run before CoStar keys are issued.
// Every result produced from this provider is labelled source: "fixture" — never present it as real CoStar data.
import type { DataLayers, TwinModel } from "./types";
import type { TwinSweep } from "../twin/sweepsToGraph";

// 4 × 4 grid of sweeps, 4 m apart: a small store with a front aisle, a back aisle and 2 cross aisles.
// Shelving occupies the middle of the grid, so only perimeter + cross-aisle neighbors are connected.
function gridSweeps(): TwinSweep[] {
  const sweeps: TwinSweep[] = [];
  const id = (r: number, c: number) => `sw-${r}${c}`;
  const walkable = (r: number, c: number) => r === 0 || r === 3 || c === 0 || c === 3 || c === 1;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    if (!walkable(r, c)) continue;
    const neighbors = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]]
      .filter(([rr, cc]) => rr >= 0 && rr < 4 && cc >= 0 && cc < 4 && walkable(rr, cc))
      .map(([rr, cc]) => id(rr, cc));
    sweeps.push({ id: id(r, c), x: c * 4, y: r * 4, floorId: "floor-1", neighbors });
  }
  return sweeps;
}

const FIXTURE_TWIN: TwinModel = {
  modelId: "fixture-model-1",
  floors: [{ id: "floor-1", label: "Ground floor" }],
  sweeps: gridSweeps(),
  panoramas: [],
  floorPlanImageUrl: null,
};

export const fixtureLayers: DataLayers = {
  source: "fixture",
  async lookupProperty(propertyId) {
    if (propertyId !== "fixture-property-1") return null;
    return {
      id: propertyId,
      name: "Fixture Corner Market (NOT real CoStar data)",
      address: "123 Fixture St, Houston, TX",
      latitude: 29.7604,
      longitude: -95.3698,
      propertyType: "Retail",
      tenants: ["Fixture Corner Market"],
      matterportModelId: FIXTURE_TWIN.modelId,
    };
  },
  async getTwin(modelId) {
    return modelId === FIXTURE_TWIN.modelId ? FIXTURE_TWIN : null;
  },
  async getAerial() {
    return { imageUrl: "", capturedAt: null, notes: "Fixture: no aerial image. Entrance assumed at sweep sw-00 (front-left)." };
  },
};
