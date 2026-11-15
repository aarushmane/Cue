import { z } from "zod";
import { sceneCatalog } from "@/lib/wayfinding/catalog";
import { loadScene } from "@/lib/wayfinding/scene";
import { assertRegistered, errorResponse, HttpError } from "@/lib/wayfinding/request";

// GET /api/wayfinding/catalog?model_id=… — the products read from the scan's photos, each placed in 3D. Built on first
// use (one vision call per photo face, cached for a week; failed builds back off for 10 minutes). Save it into the
// repo with `npm run wayfinding:catalog` so searches never need the AI for this scan.
export const maxDuration = 300;
const Query = z.object({ model_id: z.string().regex(/^[a-zA-Z0-9]{11}$/) });

export async function GET(request: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST" }, { status: 400 });
  try {
    await assertRegistered(parsed.data.model_id);
    const scene = await loadScene(parsed.data.model_id).catch((error: unknown) => {
      throw new HttpError(502, error instanceof Error ? error.message : "Could not load the space.");
    });
    const items = await sceneCatalog(scene);
    if (!items.length) throw new HttpError(503, "The catalogue could not be built (no AI provider, or its quota is used up). Try again later.");
    return Response.json({ model_id: parsed.data.model_id, at: Date.now(), items });
  } catch (error) {
    return errorResponse(error);
  }
}
