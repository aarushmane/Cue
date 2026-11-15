import { describe, expect, it, vi } from "vitest";
import { v3 } from "@/lib/wayfinding/geometry";
import type { Waypoint } from "@/lib/wayfinding/types";

// request.ts is server-only and imports the DB client; the merge under test is pure.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db/client", () => ({ getDb: () => null }));
const { mergeWaypoints } = await import("@/lib/wayfinding/request");

const api: Waypoint[] = [
  { id: "a", position: v3(0, 0, 0), camera: v3(0, 0, 1.35), rotation: { x: 0, y: 0, z: 0, w: 1 }, floorId: "f1", neighbors: ["b"], label: "0" },
  { id: "b", position: v3(3, 0, 0), camera: v3(3, 0, 1.35), rotation: { x: 0, y: 0, z: 1, w: 0 }, floorId: "f1", neighbors: ["a"], label: "1" },
  { id: "z", position: v3(9, 9, 0), floorId: "f1", neighbors: ["a", "gone"] },
];

describe("merging Showcase sweeps into the scene", () => {
  it("adds sweeps the Model API did not return and keeps API orientation where it exists", () => {
    const merged = mergeWaypoints(api, [
      { id: "a", position: v3(0, 0, 0), floor_id: "f1", neighbors: ["b", "x"] },
      { id: "b", position: v3(3, 0, 0), floor_id: "f1", neighbors: ["a", "x"] },
      { id: "x", position: v3(3, 2, 0), floor_id: "f1", neighbors: ["a", "b", "ghost"] },
    ]);
    expect(merged.map((w) => w.id)).toEqual(["a", "b", "x", "z"]);
    expect(merged[0]).toMatchObject({ rotation: api[0].rotation, camera: api[0].camera, label: "0" });
    expect(merged[2].rotation).toBeUndefined();
    expect(merged[2].neighbors).toEqual(["a", "b"]); // unknown ids dropped
    expect(merged[3].neighbors).toEqual(["a"]); // API-only sweep keeps links to sweeps that still exist
  });
});
