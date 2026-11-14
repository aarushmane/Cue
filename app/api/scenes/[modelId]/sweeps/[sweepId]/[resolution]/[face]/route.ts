import { findSkyboxFace, proxyAsset, SceneError, sceneErrorResponse, SKYBOX_RESOLUTIONS } from "@/lib/scene/matterport";
import type { SkyboxResolution } from "@/lib/scene/types";

type Params = { modelId: string; sweepId: string; resolution: string; face: string };

export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  try {
    const { modelId, sweepId, resolution, face } = await params;
    if (!/^[a-z0-9]{1,64}$/.test(sweepId) || !(resolution in SKYBOX_RESOLUTIONS) || !/^[0-5]$/.test(face)) {
      throw new SceneError("Invalid panorama request.", 400);
    }
    return await proxyAsset(request, modelId, (model) => findSkyboxFace(model, sweepId, resolution as SkyboxResolution, Number(face)), {
      "content-type": "image/jpeg",
      // Panorama pixels do not change for a given sweep and resolution.
      "cache-control": "private, max-age=86400, immutable",
    });
  } catch (error) {
    return sceneErrorResponse(error);
  }
}
