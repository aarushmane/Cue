import { loadModel, makeManifest, sceneErrorResponse } from "@/lib/scene/matterport";

export async function GET(_request: Request, { params }: { params: Promise<{ modelId: string }> }) {
  try {
    const { modelId } = await params;
    return Response.json(makeManifest(await loadModel(modelId)));
  } catch (error) {
    return sceneErrorResponse(error);
  }
}
