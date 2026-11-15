import { z } from "zod";
import { simMesh } from "@/lib/sim/matterpak";
import { assertRegistered, errorResponse, HttpError } from "@/lib/wayfinding/request";

// GET /api/sim/mesh?model_id=…[&source=matterpak] — the scan's textured mesh as a packed binary (lib/sim/matterpak.ts):
// Mann's photo-baked mesh when jb_store has one for this model, else the MatterPak.
// The first request for a model downloads and converts it (~30 s); later ones read the local cache.
export const maxDuration = 300;
const Query = z.object({ model_id: z.string().regex(/^[a-zA-Z0-9]{11}$/), source: z.enum(["auto", "matterpak"]).default("auto") });

export async function GET(request: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST" }, { status: 400 });
  try {
    await assertRegistered(parsed.data.model_id);
    const { bin, source } = await simMesh(parsed.data.model_id, parsed.data.source).catch((error: unknown) => {
      throw new HttpError(502, error instanceof Error ? error.message : "Could not load the scan's mesh.");
    });
    // x-sim-source: "baked" (Mann's photo-baked mesh, drawn as is) or "matterpak" (photos are projected live).
    return new Response(new Uint8Array(bin), { headers: { "content-type": "application/octet-stream", "cache-control": "private, max-age=3600", "x-sim-source": source } });
  } catch (error) {
    return errorResponse(error);
  }
}
