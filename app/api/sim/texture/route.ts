import { z } from "zod";
import { simTexture } from "@/lib/sim/matterpak";
import { assertRegistered, errorResponse, HttpError } from "@/lib/wayfinding/request";

// GET /api/sim/texture?model_id=…&name=… — one of the mesh's texture JPGs (names come from the mesh header).
const Query = z.object({
  model_id: z.string().regex(/^[a-zA-Z0-9]{11}$/),
  source: z.enum(["baked", "matterpak"]).default("matterpak"),
  name: z.string().regex(/^[\w.-]{1,120}\.(jpg|jpeg|png)$/i),
});

export async function GET(request: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST" }, { status: 400 });
  try {
    await assertRegistered(parsed.data.model_id);
    const image = await simTexture(parsed.data.model_id, parsed.data.source, parsed.data.name);
    if (!image) throw new HttpError(404, "No such texture.");
    const type = parsed.data.name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    return new Response(new Uint8Array(image), { headers: { "content-type": type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
  } catch (error) {
    return errorResponse(error);
  }
}
