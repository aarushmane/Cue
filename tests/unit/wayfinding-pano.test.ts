import { describe, expect, it } from "vitest";
import { detectionRay } from "@/lib/wayfinding/locate";
import { FACES } from "@/lib/wayfinding/skybox";
import { chevronsAlong, conjugate, floorChevron, floorPath, lookAtAngles, panoProjector, projectPolygon, ribbon, type PanoCamera } from "@/lib/wayfinding/pano";
import { dot, rotate, v3 } from "@/lib/wayfinding/geometry";
import type { Waypoint } from "@/lib/wayfinding/types";

const SWEEP: Waypoint = {
  id: "s", position: v3(2, 3, 0), camera: v3(2, 3, 1.35), floorId: null, neighbors: [],
  rotation: normalize4({ x: 0.1, y: -0.05, z: 0.6, w: 0.79 }),
};
function normalize4(q: { x: number; y: number; z: number; w: number }) {
  const l = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / l, y: q.y / l, z: q.z / l, w: q.w / l };
}

/** JS port of the viewer's fragment shader lookup: model direction → (face, u, v). */
function lookup(dir: { x: number; y: number; z: number }) {
  const l = rotate(conjugate(SWEEP.rotation!), dir);
  const a = { x: Math.abs(l.x), y: Math.abs(l.y), z: Math.abs(l.z) };
  const face = a.z >= a.x && a.z >= a.y ? (l.z > 0 ? 0 : 5) : a.x >= a.y ? (l.x > 0 ? 1 : 3) : (l.y > 0 ? 4 : 2);
  const f = FACES[face], k = dot(l, f.fwd);
  return { face, u: (dot(l, f.right) / k + 1) / 2, v: (1 - dot(l, f.up) / k) / 2 };
}

describe("360° viewer", () => {
  it("samples the photo pixel that detection maps to the same direction", () => {
    for (let face = 0; face < 6; face++) {
      for (const [u, v] of [[0.5, 0.5], [0.1, 0.2], [0.85, 0.7], [0.02, 0.98]]) {
        const ray = detectionRay(SWEEP, { sweepId: "s", face, u, v })!;
        const back = lookup(ray.dir);
        expect(back.face).toBe(face);
        expect(back.u).toBeCloseTo(u, 6);
        expect(back.v).toBeCloseTo(v, 6);
      }
    }
  });

  const cam: PanoCamera = { eye: v3(0, 0, 1.35), yawDeg: 0, pitchDeg: 0, vfovDeg: 90, w: 800, h: 600 };
  it("projects with heading 0 = +x and up = +z", () => {
    const project = panoProjector(cam);
    expect(project(v3(5, 0, 1.35))).toMatchObject({ x: 400, y: 300, z: 0 });
    expect(project(v3(5, -1, 1.35)).x).toBeGreaterThan(400); // −y is to the right when facing +x
    expect(project(v3(5, 0, 0)).y).toBeGreaterThan(300); // the floor is below the horizon
    expect(project(v3(-5, 1, 1.35)).z).toBe(2);
    const a = lookAtAngles(cam.eye, v3(0, 4, 1.35));
    expect(a.yawDeg).toBeCloseTo(90);
    expect(a.pitchDeg).toBeCloseTo(0);
  });

  it("clips floor shapes at the camera so a path under the visitor reaches the bottom edge", () => {
    const band = ribbon([v3(-3, 0, 0), v3(6, 0, 0)], 0.2);
    expect(band).toHaveLength(4);
    const shown = projectPolygon(cam, band);
    expect(shown.length).toBeGreaterThanOrEqual(4);
    expect(Math.max(...shown.map((p) => p.y))).toBeGreaterThan(600 * 5);
    expect(Math.min(...shown.map((p) => p.y))).toBeGreaterThan(300); // all on the floor
    expect(projectPolygon(cam, floorChevron(v3(-4, 0, 0), 0))).toEqual([]); // behind: nothing drawn
  });

  it("mitres the band around corners at constant width", () => {
    const band = ribbon([v3(0, 0, 0), v3(2, 0, 0), v3(2, 2, 0)], 0.25, 0);
    expect(band).toHaveLength(6);
    expect(band[1].x).toBeCloseTo(1.75); expect(band[1].y).toBeCloseTo(0.25); // inner corner
    expect(band[4].x).toBeCloseTo(2.25); expect(band[4].y).toBeCloseTo(-0.25); // outer corner
  });
});

describe("floor path", () => {
  it("continues from the stand point to just short of the item, with chevrons along it", () => {
    const path = floorPath([v3(0, 0, 0)], v3(2, 0, 1)); // already there, item 2 m ahead on a shelf
    expect(path).toHaveLength(2);
    expect(path[1]).toMatchObject({ x: 1.55, y: 0, z: 0 });
    const marks = chevronsAlong(path, 0.5, 0.3);
    expect(marks.map((m) => m.position.x)).toEqual([0.3, 0.8, 1.3]);
    expect(marks.every((m) => m.headingDeg === 0)).toBe(true);
    expect(floorPath([v3(0, 0, 0)], v3(0.4, 0, 1))).toHaveLength(1); // item at arm's length: nothing to walk
  });
});
