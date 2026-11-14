import "server-only";
import { getDb } from "@/lib/db/client";
import type { Quat, SceneManifest, SkyboxResolution, Sweep, Vec3 } from "./types";

type Signed = { urlTemplate?: string | null; validUntil?: string | null } | null;

type Model = {
  id: string;
  name?: string;
  modified?: string;
  assets?: { meshes?: { id: string; filename: string; url?: string | null; validUntil?: string | null }[] };
  panoLocations?: {
    id: string;
    label?: string;
    position?: Vec3 | null;
    rotation?: Quat | null;
    anchor?: { id: string; position?: Vec3 | null; neighbors?: string[] | null; floor?: { id: string } | null } | null;
    high?: Signed;
    hd?: Signed;
  }[];
};

// Signed asset URLs from this API are valid for roughly five minutes, so the metadata is cached
// in memory only until shortly before `validUntil`, never in the long-lived fetch cache.
const query = `query Scene($id: ID!) {
  model(id: $id) {
    id name modified
    assets { meshes(formats: "obj") { id filename url validUntil } }
    panoLocations {
      id label position { x y z } rotation { x y z w }
      anchor { id position { x y z } neighbors floor { id } }
      high: skybox(resolution: "high") { urlTemplate validUntil }
      hd: skybox(resolution: "2k") { urlTemplate validUntil }
    }
  }
}`;

export const SKYBOX_RESOLUTIONS: Record<SkyboxResolution, "high" | "hd"> = { high: "high", "2k": "hd" };

export class SceneError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

const cache = new Map<string, { expires: number; model: Promise<Model> }>();

export async function loadModel(modelId: string, fresh = false): Promise<Model> {
  if (!/^[a-zA-Z0-9]{11}$/.test(modelId)) throw new SceneError("Invalid model ID.", 400);
  const hit = cache.get(modelId);
  if (!fresh && hit && hit.expires > Date.now()) return hit.model;
  const model = fetchModel(modelId);
  // Concurrent requests (one mesh + many skybox faces) share one metadata request.
  cache.set(modelId, { expires: Date.now() + 60_000, model });
  try {
    const value = await model;
    const until = Date.parse(value.assets?.meshes?.[0]?.validUntil ?? "");
    const expires = Number.isFinite(until) ? Math.min(until - 60_000, Date.now() + 240_000) : Date.now() + 60_000;
    cache.set(modelId, { expires, model });
    return value;
  } catch (error) {
    cache.delete(modelId);
    throw error;
  }
}

async function fetchModel(modelId: string): Promise<Model> {
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
    cache: "no-store",
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

export function findSkyboxFace(model: Model, sweepId: string, resolution: SkyboxResolution, face: number) {
  const pano = model.panoLocations?.find((location) => location.id === sweepId);
  const template = pano?.[SKYBOX_RESOLUTIONS[resolution]]?.urlTemplate;
  if (!template) throw new SceneError("This panorama is unavailable.", 404);
  return template.replace("<face>", String(face));
}

const finite = (p?: Vec3 | null): p is Vec3 => !!p && [p.x, p.y, p.z].every(Number.isFinite);
/** Source Z-up → viewer Y-up. Keep in sync with the mesh rotation in the viewer. */
const toViewer = (p: Vec3): Vec3 => ({ x: p.x, y: p.z, z: -p.y });

export function makeManifest(model: Model): SceneManifest {
  const mesh = findMesh(model);
  const sweeps: Sweep[] = (model.panoLocations ?? []).flatMap((pano) => {
    const resolutions = (Object.keys(SKYBOX_RESOLUTIONS) as SkyboxResolution[]).filter((r) => pano[SKYBOX_RESOLUTIONS[r]]?.urlTemplate);
    if (!finite(pano.position) || !pano.rotation || !resolutions.length) return [];
    const floor = finite(pano.anchor?.position) ? pano.anchor!.position!.z : pano.position.z - 1.35;
    return [{
      id: pano.id,
      label: pano.label ?? "",
      floorId: pano.anchor?.floor?.id ?? null,
      position: toViewer(pano.position),
      floorY: floor,
      rotation: pano.rotation,
      neighbors: pano.anchor?.neighbors ?? [],
      resolutions,
    }];
  });
  const ids = new Set(sweeps.map((sweep) => sweep.id));
  for (const sweep of sweeps) sweep.neighbors = sweep.neighbors.filter((id) => ids.has(id));
  // Matterport labels sweeps in capture order; "0" is the first scan position.
  const start = [...sweeps].sort((a, b) => (Number(a.label) || 0) - (Number(b.label) || 0))[0];
  return {
    modelId: model.id,
    name: model.name || model.id,
    revision: model.modified ?? null,
    units: "metres",
    coordinates: { source: "Z-up", viewer: "Y-up", conversion: "(x, y, z) → (x, z, -y)" },
    mesh: { url: `/api/scenes/${model.id}/mesh`, assetId: mesh.id, format: "obj" },
    skybox: { urlTemplate: `/api/scenes/${model.id}/sweeps/{sweep}/{resolution}/{face}` },
    sweeps,
    startSweepId: start?.id ?? null,
    cameraStart: start?.position ?? null,
  };
}

/** Streams a signed Matterport asset, refreshing the metadata once if the link has expired. */
export async function proxyAsset(request: Request, modelId: string, pick: (model: Model) => string, headers: HeadersInit) {
  const download = async (fresh: boolean) => fetch(pick(await loadModel(modelId, fresh)), {
    cache: "no-store",
    signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]),
  });
  let response = await download(false);
  if ([401, 403, 404].includes(response.status)) {
    await response.body?.cancel();
    response = await download(true);
  }
  if (!response.ok) throw new SceneError("The asset could not be downloaded from Matterport.");
  return new Response(response.body, { headers });
}

export function sceneErrorResponse(error: unknown) {
  return Response.json(
    { error: error instanceof SceneError ? error.message : "Could not load the scene. Try again." },
    { status: error instanceof SceneError ? error.status : 502 },
  );
}
