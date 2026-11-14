import { findMesh, proxyAsset, sceneErrorResponse } from "@/lib/scene/matterport";

export async function GET(request: Request, { params }: { params: Promise<{ modelId: string }> }) {
  try {
    const { modelId } = await params;
    return await proxyAsset(request, modelId, (model) => findMesh(model).url!, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "private, max-age=300",
    });
  } catch (error) {
    return sceneErrorResponse(error);
  }
}
