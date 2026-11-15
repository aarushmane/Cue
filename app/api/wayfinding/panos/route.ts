import { z } from "zod";
import { loadScene } from "@/lib/wayfinding/scene";
import { assertRegistered, errorResponse, HttpError } from "@/lib/wayfinding/request";

// GET /api/wayfinding/panos?model_id=… — where the built-in viewer can stand: scan points with a 360° photo (floor
// point, camera centre, photo orientation) and aisle points added from the mesh, with the links between them
// (Model API frame).
const Query = z.object({ model_id: z.string().regex(/^[a-zA-Z0-9]{11}$/) });

export async function GET(request: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST" }, { status: 400 });
  try {
    await assertRegistered(parsed.data.model_id);
    const scene = await loadScene(parsed.data.model_id).catch((error: unknown) => {
      throw new HttpError(502, error instanceof Error ? error.message : "Could not load the space.");
    });
    // Photo points first (capture order), then aisle points (added from the mesh; no photo, shown as a 3D view).
    const sweeps = scene.waypoints
      .filter((w) => w.camera && (w.kind === "aisle" || w.rotation))
      .sort((a, b) => (a.kind === "aisle" ? 1 : 0) - (b.kind === "aisle" ? 1 : 0) || (Number(a.label) || 0) - (Number(b.label) || 0))
      .map((w) => ({
        id: w.id, kind: w.kind ?? "photo", label: w.label ?? null, position: w.position, camera: w.camera!,
        rotation: w.rotation ?? null, neighbors: w.neighbors,
      }));
    return Response.json({ sweeps }, { headers: { "cache-control": "private, max-age=60" } });
  } catch (error) {
    return errorResponse(error);
  }
}
