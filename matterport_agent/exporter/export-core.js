// Pure export logic for the sweep exporter page. No DOM, no SDK calls, so it can be unit-tested with Node.
//
// Input is the collection delivered by the Matterport SDK's `mpSdk.Sweep.data.subscribe({ onCollectionUpdated })`:
// an object of ObservableSweepData keyed by sweep, each with id, sid, uuid, enabled, alignmentType,
// placementType, neighbors, position, puckPosition, floorInfo { id, sequence }.

export const EXPORT_FORMAT = "storeguide.matterport-sweeps";
export const EXPORT_FORMAT_VERSION = 1;
const ID_FIELDS = ["id", "sid", "uuid"];

function isFiniteVec(v) {
  return v != null && ["x", "y", "z"].every((k) => typeof v[k] === "number" && Number.isFinite(v[k]));
}

function vec(v) {
  return { x: v.x, y: v.y, z: v.z };
}

/**
 * The SDK gives each sweep three IDs. Neighbor lists use one of them; pick the field whose values
 * cover every neighbor ID and are unique. Returns null when no field fits, so nothing is guessed.
 */
export function chooseSweepIdField(sweeps) {
  const neighborIds = new Set(sweeps.flatMap((s) => s.neighbors ?? []));
  if (neighborIds.size === 0) return null;
  for (const field of ID_FIELDS) {
    const values = sweeps.map((s) => s[field]);
    if (values.some((v) => typeof v !== "string" || v === "")) continue;
    const ids = new Set(values);
    if (ids.size !== sweeps.length) continue;
    if ([...neighborIds].every((n) => ids.has(n))) return field;
  }
  return null;
}

/** SDK floorInfo -> { id, sequence } or null when the sweep has no floor assignment. */
export function normalizeFloor(floorInfo) {
  if (!floorInfo || typeof floorInfo.id !== "string" || floorInfo.id === "") return null;
  if (!Number.isInteger(floorInfo.sequence) || floorInfo.sequence < 0) return null;
  return { id: floorInfo.id, sequence: floorInfo.sequence };
}

/**
 * Build the JSON document. Throws an Error with a readable message on anything that can't be
 * exported faithfully (bad coordinates, no matching ID field, unknown start/destination sweep).
 * The SDK key is never an input, so it can't end up in the file.
 */
export function buildExport({ modelId, collection, startSweepId = null, destinations = [], sdkVersion, now = new Date() }) {
  if (typeof modelId !== "string" || modelId.trim() === "") throw new Error("Model ID is empty.");
  const sweeps = Object.values(collection ?? {});
  if (sweeps.length === 0) throw new Error("The SDK returned no sweeps. Wait for the tour to finish loading.");

  const idField = chooseSweepIdField(sweeps);
  if (!idField) {
    throw new Error("Couldn't match neighbor IDs to any sweep ID field (id, sid, uuid). Nothing was exported.");
  }

  const out = sweeps.map((s) => {
    const sweepId = s[idField];
    if (!isFiniteVec(s.position)) throw new Error(`Sweep ${sweepId} has no valid SDK position.`);
    if (s.puckPosition != null && !isFiniteVec(s.puckPosition)) throw new Error(`Sweep ${sweepId} has an invalid puck position.`);
    return {
      sweep_id: sweepId,
      id: s.id ?? null,
      sid: s.sid ?? null,
      uuid: s.uuid ?? null,
      enabled: s.enabled !== false,
      alignment_type: s.alignmentType ?? null,
      placement_type: s.placementType ?? null,
      position: vec(s.position),
      puck_position: s.puckPosition != null ? vec(s.puckPosition) : null,
      floor: normalizeFloor(s.floorInfo),
      neighbors: [...(s.neighbors ?? [])],
    };
  });
  out.sort((a, b) => (a.sweep_id < b.sweep_id ? -1 : a.sweep_id > b.sweep_id ? 1 : 0));

  const known = new Set(out.map((s) => s.sweep_id));
  if (startSweepId != null && !known.has(startSweepId)) throw new Error(`Start sweep ${startSweepId} isn't in this model.`);
  const seen = new Set();
  const dests = destinations.map((d) => {
    const name = (d.name ?? "").trim();
    if (!name) throw new Error("A destination has an empty name.");
    if (seen.has(name.toLowerCase())) throw new Error(`Destination "${name}" is labeled twice.`);
    seen.add(name.toLowerCase());
    if (!known.has(d.sweep_id)) throw new Error(`Destination "${name}" points to unknown sweep ${d.sweep_id}.`);
    const aliases = (d.aliases ?? []).map((a) => a.trim()).filter(Boolean);
    return { name, sweep_id: d.sweep_id, aliases };
  });

  return {
    format: EXPORT_FORMAT,
    format_version: EXPORT_FORMAT_VERSION,
    exported_at: now.toISOString(),
    sdk_version: sdkVersion ?? null,
    model_id: modelId.trim(),
    coordinate_system: "MATTERPORT_SDK_WORLD",
    sweep_id_field: idField,
    start_sweep_id: startSweepId,
    destinations: dests,
    sweeps: out,
  };
}
