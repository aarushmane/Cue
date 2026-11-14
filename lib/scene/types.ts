export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };

export type SkyboxResolution = "high" | "2k";

/** One Matterport scan position. Positions are in the viewer frame (Y-up, metres). */
export type Sweep = {
  id: string;
  label: string;
  floorId: string | null;
  /** Panorama camera centre (viewer frame). */
  position: Vec3;
  /** Height of the floor directly under the scanner (viewer frame Y). */
  floorY: number;
  /**
   * Panorama orientation as reported by Matterport, in the SOURCE frame (Z-up): rotates the
   * skybox's local frame into model coordinates. Skybox local frame: face 1 looks along +x,
   * its image right is −y, image up is +z; faces 2–4 continue clockwise seen from above
   * (−y, −x, +y); face 0 looks up (+z) and face 5 down, both with their image top toward −x / +x
   * respectively, i.e. a standard cross unfolded around face 1.
   */
  rotation: Quat;
  neighbors: string[];
  resolutions: SkyboxResolution[];
};

export type SceneManifest = {
  modelId: string;
  name: string;
  revision: string | null;
  units: "metres";
  coordinates: { source: "Z-up"; viewer: "Y-up"; conversion: "(x, y, z) → (x, z, -y)" };
  mesh: { url: string; assetId: string; format: "obj" };
  /** Replace `{sweep}`, `{resolution}` and `{face}` (0–5). Served same-origin through the proxy. */
  skybox: { urlTemplate: string };
  sweeps: Sweep[];
  startSweepId: string | null;
  cameraStart: Vec3 | null;
};
