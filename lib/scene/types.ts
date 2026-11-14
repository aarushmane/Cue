export type Vec3 = { x: number; y: number; z: number };

export type SceneManifest = {
  modelId: string;
  name: string;
  revision: string | null;
  units: "metres";
  coordinates: { source: "Z-up"; viewer: "Y-up"; conversion: "(x, y, z) → (x, z, -y)" };
  mesh: { url: string; assetId: string; format: "obj"; textured: false };
  cameraStart: Vec3 | null;
  provenance: "Original Matterport OBJ; no panorama textures or derived point cloud";
};
