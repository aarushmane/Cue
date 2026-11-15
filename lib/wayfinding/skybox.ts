// Matterport skybox faces in pano-local axes (z up). Face 0 looks up, 1–4 look around the horizon clockwise seen from
// above, 5 looks down. A pixel (u, v) in a face (0,0 = top-left) is the direction fwd + right·(2u−1) + up·(1−2v); the
// pano's `rotation` quaternion turns that into the model frame. Shared by detection (locate.ts) and the viewer.
// Verified against the scan mesh by colour agreement across sweeps.
import type { Vec3 } from "./types";

const v3 = (x: number, y: number, z: number): Vec3 => ({ x, y, z });

export const FACES: { fwd: Vec3; right: Vec3; up: Vec3 }[] = [
  { fwd: v3(0, 0, 1), right: v3(0, -1, 0), up: v3(-1, 0, 0) },
  { fwd: v3(1, 0, 0), right: v3(0, -1, 0), up: v3(0, 0, 1) },
  { fwd: v3(0, -1, 0), right: v3(-1, 0, 0), up: v3(0, 0, 1) },
  { fwd: v3(-1, 0, 0), right: v3(0, 1, 0), up: v3(0, 0, 1) },
  { fwd: v3(0, 1, 0), right: v3(1, 0, 0), up: v3(0, 0, 1) },
  { fwd: v3(0, 0, -1), right: v3(0, -1, 0), up: v3(1, 0, 0) },
];
