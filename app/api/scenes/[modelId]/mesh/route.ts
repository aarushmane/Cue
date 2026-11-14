import { findMesh, loadModel, SceneError, sceneErrorResponse } from "@/lib/scene/matterport";

export async function GET(request: Request, { params }: { params: Promise<{ modelId: string }> }) {
  try {
    const { modelId } = await params;
    const download = async (fresh: boolean) => {
      const mesh = findMesh(await loadModel(modelId, fresh));
      return fetch(mesh.url!, { cache: "no-store", signal: AbortSignal.any([request.signal, AbortSignal.timeout(30_000)]) });
    };
    let response = await download(false);
    // Signed URLs are temporary. Refresh the metadata once if one has expired.
    if ([401, 403, 404].includes(response.status)) {
      await response.body?.cancel();
      response = await download(true);
    }
    if (!response.ok) throw new SceneError("The mesh could not be downloaded from Matterport.");
    return new Response(response.body, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "private, max-age=300" },
    });
  } catch (error) {
    return sceneErrorResponse(error);
  }
}
