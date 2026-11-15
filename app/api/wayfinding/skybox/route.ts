import { z } from "zod";
import { skyboxTemplates } from "@/lib/wayfinding/scene";
import { assertRegistered, errorResponse, HttpError } from "@/lib/wayfinding/request";

// GET /api/wayfinding/skybox?model_id=…&sweep_id=…&face=0-5 — one 360° photo face, proxied. Matterport's signed URLs
// expire within minutes and are served without CORS headers, so WebGL cannot load them directly.
const Query = z.object({
  model_id: z.string().regex(/^[a-zA-Z0-9]{11}$/),
  sweep_id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  face: z.coerce.number().int().min(0).max(5),
  res: z.enum(["high", "2k", "4k"]).default("high"),
});

// Recently served faces (≈150 KB each), so moving back and forth doesn't refetch.
const faces = new Map<string, { at: number; body: ArrayBuffer; type: string }>();
const MAX_FACES = 60;
const MAX_BYTES = 200 * 1024 * 1024;
const FACE_TTL_MS = 60 * 60_000;

export async function GET(request: Request) {
  const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return Response.json({ error: "BAD_REQUEST" }, { status: 400 });
  const { model_id, sweep_id, face, res } = parsed.data;
  const key = `${model_id}/${sweep_id}/${face}/${res}`;
  const headers = (type: string) => ({ "content-type": type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" });
  try {
    const hit = faces.get(key);
    if (hit && Date.now() - hit.at < FACE_TTL_MS) return new Response(hit.body, { headers: headers(hit.type) });
    await assertRegistered(model_id);
    const template = (await skyboxTemplates(model_id, res)).get(sweep_id);
    if (!template) throw new HttpError(404, "No photo for that scan point.");
    const url = new URL(template.replace("<face>", String(face)));
    if (!url.hostname.endsWith(".matterport.com")) throw new HttpError(502, "Unexpected photo host.");
    const upstream = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    const type = upstream.headers.get("content-type") ?? "";
    if (!upstream.ok || !type.startsWith("image/")) throw new HttpError(502, "Could not load the photo.");
    const body = await upstream.arrayBuffer();
    faces.set(key, { at: Date.now(), body, type });
    // Bounded by count and size (a 4k face is ~3 MB).
    let bytes = 0;
    for (const f of faces.values()) bytes += f.body.byteLength;
    while (faces.size > MAX_FACES || bytes > MAX_BYTES) {
      const oldest = faces.keys().next().value!;
      bytes -= faces.get(oldest)!.body.byteLength;
      faces.delete(oldest);
    }
    return new Response(body, { headers: headers(type) });
  } catch (error) {
    return errorResponse(error);
  }
}
