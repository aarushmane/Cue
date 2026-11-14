// Real CoStar-track data layers: CoStar id → Matterport model (models_index.csv) → twin (Model API) → Vexcel ortho.
import { costarKitConfigured, costarRecord, tenantsFrom } from "./costarKit";
import { fetchTwin, graph, MatterportError, Q_BASICS } from "./matterport";
import { findByCostarId, findBySid } from "./modelsIndex";
import type { CostarProperty, DataLayers } from "./types";
import { orthoAround, vexcelConfigured } from "./vexcel";
import { fixtureLayers } from "./fixture";

interface RawBasics {
  id: string;
  name?: string;
  internalId?: string;
  address?: { address?: string; locality?: string; administrativeArea?: string; postalCode?: string };
  geolocation?: { lat?: string | number; long?: string | number };
  propertyClassifications?: { classification?: string }[];
}

const AERIAL_HALF_M = 70;

export const liveLayers: DataLayers = {
  source: "costar",

  /** Accepts a CoStar property id (digits) or a Matterport model id (sid). */
  async lookupProperty(propertyId) {
    if (propertyId === "fixture-property-1") return fixtureLayers.lookupProperty(propertyId);
    const isCostarId = /^\d+$/.test(propertyId);
    const row = isCostarId ? await findByCostarId(propertyId) : await findBySid(propertyId);
    const sid = row?.sid ?? (isCostarId ? null : propertyId);
    if (!sid) return null;

    let m: RawBasics | null = null;
    try {
      m = (await graph<{ model: RawBasics | null }>(Q_BASICS, { id: sid })).model;
    } catch (err) {
      if (!(err instanceof MatterportError && err.message === "not.found")) throw err;
    }
    if (!m && !row) return null;

    const costarId = isCostarId ? propertyId : row?.costar_property_id || (/^\d+$/.test(m?.internalId ?? "") ? m!.internalId! : null);
    const record = costarId && costarKitConfigured() ? await costarRecord(costarId) : null;
    const lat = Number(m?.geolocation?.lat ?? row?.lat);
    const lon = Number(m?.geolocation?.long ?? row?.lon);
    const p: CostarProperty = {
      id: costarId ?? sid,
      name: m?.name ?? row?.name ?? sid,
      address: m?.address?.address ?? row?.address ?? "",
      latitude: lat,
      longitude: lon,
      // The index name often carries the CoStar type ("Retail - 15,000SF"); Matterport adds a vision classification.
      propertyType: row?.name.match(/^([A-Za-z/ ]+?)\s+-\s+[\d,]+\s*SF/i)?.[1] ?? m?.propertyClassifications?.[0]?.classification ?? null,
      tenants: tenantsFrom(record),
      matterportModelId: sid,
      costarRecord: record,
    };
    return p;
  },

  async getTwin(modelId) {
    if (modelId === "fixture-model-1") return fixtureLayers.getTwin(modelId);
    return fetchTwin(modelId);
  },

  async getAerial(lat, lng) {
    if (!vexcelConfigured() || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return { imageDataUrl: null, capturedAt: null, extentM: null, notes: "Vexcel is not configured or the property has no coordinates." };
    }
    const img = await orthoAround(lat, lng, AERIAL_HALF_M);
    if (!img) return { imageDataUrl: null, capturedAt: null, extentM: null, notes: "Vexcel has no coverage here (Houston and Los Angeles only)." };
    return {
      imageDataUrl: img,
      capturedAt: null,
      extentM: AERIAL_HALF_M * 2,
      notes: `Vexcel orthophoto, north up, ${AERIAL_HALF_M * 2} m square centered on the property's coordinates.`,
    };
  },
};
