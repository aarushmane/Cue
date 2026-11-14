import "server-only";
import { getDb } from "@/lib/db/client";
import type { SceneManifest, Vec3 } from "./types";

type Model = {
  id: string;
  name?: string;
  modified?: string;
  panoLocations?: { position?: Vec3 | null }[];
  assets?: { meshes?: { id: string; filename: string; url?: string | null }[] };
};

const query = `query Scene($id: ID!) {
  model(id: $id) {
    id name modified
    panoLocations { position { x y z } }
    assets { meshes(formats: "obj") { id filename url } }
  }
}`;

export class SceneError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

export async function loadModel(modelId: string, fresh = false) {
  if (!/^[a-zA-Z0-9]{11}$/.test(modelId)) throw new SceneError("Invalid model ID.", 400);
  const registered = await getDb("read").from("stores").select("id").eq("matterport_model_id", modelId).limit(1);
  if (registered.error) throw new SceneError("Could not look up the saved scene.", 503);
  if (!registered.data?.length) throw new SceneError("Add this model to a property before viewing it.", 404);
  const key = process.env.MATTERPORT_API_KEY;
  const token = process.env.MATTERPORT_API_TOKEN;
  if (!key || !token) throw new SceneError("Configure the server's Matterport API credentials.", 503);
  const response = await fetch("https://api.matterport.com/api/models/graph", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`${key}:${token}`).toString("base64")}`,
    },
    body: JSON.stringify({ query, variables: { id: modelId } }),
    ...(fresh ? { cache: "no-store" as const } : { next: { revalidate: 300 } }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new SceneError("Matterport could not load this scan.");
  const body = await response.json() as { data?: { model?: Model | null }; errors?: unknown[] };
  if (body.errors?.length) throw new SceneError("Matterport rejected the model query.");
  if (!body.data?.model) throw new SceneError("This scan is unavailable to the configured account.", 404);
  return body.data.model;
}

export function findMesh(model: Model) {
  const meshes = model.assets?.meshes ?? [];
  const mesh = meshes.find((asset) => asset.filename === "out_res_50k.obj") ?? meshes[0];
  if (!mesh?.url) throw new SceneError("This scan has no available OBJ mesh.", 404);
  return mesh;
}

export function makeManifest(model: Model): SceneManifest {
  const mesh = findMesh(model);
  const p = model.panoLocations?.find(({ position }) => position && [position.x, position.y, position.z].every(Number.isFinite))?.position;
  return {
    modelId: model.id,
    name: model.name || model.id,
    revision: model.modified ?? null,
    units: "metres",
    coordinates: { source: "Z-up", viewer: "Y-up", conversion: "(x, y, z) → (x, z, -y)" },
    mesh: { url: `/api/scenes/${model.id}/mesh`, assetId: mesh.id, format: "obj", textured: false },
    cameraStart: p ? { x: p.x, y: p.z, z: -p.y } : null,
    provenance: "Original Matterport OBJ; no panorama textures or derived point cloud",
  };
}

export function sceneErrorResponse(error: unknown) {
  return Response.json(
    { error: error instanceof SceneError ? error.message : "Could not load the scene. Try again." },
    { status: error instanceof SceneError ? error.status : 502 },
  );
}
