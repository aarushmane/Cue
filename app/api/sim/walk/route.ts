import { z } from "zod";
import { loadScene } from "@/lib/wayfinding/scene";
import { assertRegistered, errorResponse, HttpError } from "@/lib/wayfinding/request";

// GET /api/sim/walk?model_id=… — the walkable floor grid (from the scan mesh) so the simulation can stop the visitor
// walking through shelves. Clearance per 10 cm cell in centimetres (0 = blocked, capped at 255), base64.
const Query = z.object({ model_id: z.string().regex(/^[a-zA-Z0-9]{11}$/) });

export async function GET(request: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST" }, { status: 400 });
  try {
    await assertRegistered(parsed.data.model_id);
    const scene = await loadScene(parsed.data.model_id).catch((error: unknown) => {
      throw new HttpError(502, error instanceof Error ? error.message : "Could not load the space.");
    });
    const g = scene.walk;
    if (!g) throw new HttpError(404, "This scan has no mesh to walk on.");
    const cm = Uint8Array.from(g.clearance, (c) => Math.min(255, Math.round(c * 100)));
    const eye = scene.waypoints.flatMap((w) => (w.camera ? [w.camera.z - w.position.z] : []));
    return Response.json({
      minX: g.minX, minY: g.minY, cell: g.cell, nx: g.nx, ny: g.ny, floorZ: g.floorZ,
      eyeHeight: eye.length ? eye.reduce((a, b) => a + b, 0) / eye.length : 1.35,
      clearance: Buffer.from(cm).toString("base64"),
    }, { headers: { "cache-control": "private, max-age=600" } });
  } catch (error) {
    return errorResponse(error);
  }
}
