// The scan's surface mesh, used to turn a single photo detection into a 3D point: cast the detection's ray from the
// sweep camera and take the first surface it hits. Pure and dependency-free.
import type { Ray } from "./geometry";

/** Triangles as a flat list: [ax, ay, az, bx, by, bz, cx, cy, cz, …] in the Model API frame. */
export type Surfaces = Float32Array;

/** Parse the `v` and `f` lines of a Matterport OBJ (Model API frame, z up). Faces with > 3 vertices are fanned. */
export function parseObj(source: string): Surfaces {
  const verts: number[] = [];
  const tris: number[] = [];
  for (const line of source.split("\n")) {
    if (line.startsWith("v ")) {
      const [, x, y, z] = line.trim().split(/\s+/);
      verts.push(Number(x), Number(y), Number(z));
    } else if (line.startsWith("f ")) {
      const idx = line.trim().split(/\s+/).slice(1).map((t) => {
        const i = parseInt(t.split("/")[0], 10);
        return (i < 0 ? verts.length / 3 + i : i - 1) * 3;
      });
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const v of [idx[0], idx[k], idx[k + 1]]) tris.push(verts[v], verts[v + 1], verts[v + 2]);
      }
    }
  }
  return Float32Array.from(tris);
}

/** Distance along `ray` (unit direction) to the nearest triangle hit beyond `minT`, or null (Möller–Trumbore). */
export function raycast(surfaces: Surfaces, ray: Ray, minT = 0.3, maxT = 60): number | null {
  const { x: ox, y: oy, z: oz } = ray.origin;
  const { x: dx, y: dy, z: dz } = ray.dir;
  let best = maxT;
  let hit = false;
  for (let i = 0; i < surfaces.length; i += 9) {
    const ax = surfaces[i], ay = surfaces[i + 1], az = surfaces[i + 2];
    const e1x = surfaces[i + 3] - ax, e1y = surfaces[i + 4] - ay, e1z = surfaces[i + 5] - az;
    const e2x = surfaces[i + 6] - ax, e2y = surfaces[i + 7] - ay, e2z = surfaces[i + 8] - az;
    const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (det > -1e-9 && det < 1e-9) continue; // parallel
    const inv = 1 / det;
    const tx = ox - ax, ty = oy - ay, tz = oz - az;
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) continue;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (dx * qx + dy * qy + dz * qz) * inv;
    if (v < 0 || u + v > 1) continue;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    if (t > minT && t < best) { best = t; hit = true; }
  }
  return hit ? best : null;
}
