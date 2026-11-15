import { z } from "zod";
import { loadScene } from "@/lib/wayfinding/scene";
import { assertRegistered, errorResponse, HttpError } from "@/lib/wayfinding/request";

// GET /api/wayfinding/mesh?model_id=… — the scan's surface mesh as little-endian float32 triangles
// [ax, ay, az, bx, by, bz, cx, cy, cz, …] in the Model API frame. The built-in viewer draws aisle points from it.
const Query = z.object({ model_id: z.string().regex(/^[a-zA-Z0-9]{11}$/) });

export async function GET(request: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST" }, { status: 400 });
  try {
    await assertRegistered(parsed.data.model_id);
    const scene = await loadScene(parsed.data.model_id).catch((error: unknown) => {
      throw new HttpError(502, error instanceof Error ? error.message : "Could not load the space.");
    });
    if (!scene.surfaces?.length) throw new HttpError(404, "This scan has no mesh.");
    const bytes = new Uint8Array(scene.surfaces.buffer, scene.surfaces.byteOffset, scene.surfaces.byteLength);
    return new Response(bytes.slice(), { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=3600" } });
  } catch (error) {
    return errorResponse(error);
  }
}
