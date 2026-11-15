// Run: node --test exporter/export-core.test.mjs   (from matterport_agent/)
import assert from "node:assert/strict";
import test from "node:test";

import { buildExport, chooseSweepIdField, normalizeFloor } from "./export-core.js";

// Shaped like SDK ObservableSweepData. Values are made up for the test.
function sweep(id, neighbors, extra = {}) {
  return {
    id, sid: `sid-${id}`, uuid: `uuid-${id}`, enabled: true, alignmentType: "aligned", placementType: "auto",
    neighbors, position: { x: 1, y: 1.5, z: 2 }, puckPosition: { x: 1, y: 0, z: 2 },
    floorInfo: { id: "floor-a", sequence: 0 }, ...extra,
  };
}

test("picks the ID field that neighbor lists use", () => {
  assert.equal(chooseSweepIdField([sweep("a", ["b"]), sweep("b", ["a"])]), "id");
  const bySid = [sweep("a", ["sid-b"]), sweep("b", ["sid-a"])];
  assert.equal(chooseSweepIdField(bySid), "sid");
});

test("refuses to guess when no ID field matches", () => {
  assert.equal(chooseSweepIdField([sweep("a", ["zzz"])]), null);
  assert.equal(chooseSweepIdField([sweep("a", [])]), null);
  assert.throws(() => buildExport({ modelId: "M", collection: { a: sweep("a", ["zzz"]) } }), /Couldn't match neighbor IDs/);
});

test("floor info is kept or explicitly null", () => {
  assert.deepEqual(normalizeFloor({ id: "f", sequence: 1 }), { id: "f", sequence: 1 });
  assert.equal(normalizeFloor(undefined), null);
  assert.equal(normalizeFloor({ id: "", sequence: -1 }), null);
});

test("builds a complete export without the SDK key", () => {
  const collection = { a: sweep("a", ["b"]), b: sweep("b", ["a"], { puckPosition: undefined, floorInfo: undefined }) };
  const out = buildExport({
    modelId: " M ", collection, startSweepId: "a", sdkVersion: "test",
    destinations: [{ name: " Checkout ", sweep_id: "b", aliases: ["registers", " "] }],
    now: new Date("2026-01-01T00:00:00Z"),
  });
  assert.equal(out.model_id, "M");
  assert.equal(out.sweep_id_field, "id");
  assert.equal(out.start_sweep_id, "a");
  assert.deepEqual(out.destinations, [{ name: "Checkout", sweep_id: "b", aliases: ["registers"] }]);
  assert.equal(out.sweeps[1].puck_position, null);
  assert.equal(out.sweeps[1].floor, null);
  assert.ok(!JSON.stringify(out).toLowerCase().includes("applicationkey"));
});

test("rejects bad coordinates, unknown start, duplicate labels", () => {
  const bad = { a: sweep("a", ["b"], { position: { x: NaN, y: 0, z: 0 } }), b: sweep("b", ["a"]) };
  assert.throws(() => buildExport({ modelId: "M", collection: bad }), /no valid SDK position/);
  const ok = { a: sweep("a", ["b"]), b: sweep("b", ["a"]) };
  assert.throws(() => buildExport({ modelId: "M", collection: ok, startSweepId: "nope" }), /Start sweep/);
  const dup = [{ name: "X", sweep_id: "a" }, { name: "x", sweep_id: "b" }];
  assert.throws(() => buildExport({ modelId: "M", collection: ok, destinations: dup }), /labeled twice/);
});
