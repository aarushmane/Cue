import { timingSafeEqual } from "node:crypto";
import { addProperty } from "@/lib/db/properties";
import { parseProperty } from "@/lib/properties/types";

export async function POST(request: Request) {
  const expected = process.env.PROPERTY_WRITE_TOKEN;
  if (!expected) return Response.json({ error: "Configure PROPERTY_WRITE_TOKEN on the server." }, { status: 503 });
  const provided = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  const input = parseProperty(body);
  if (!input) {
    return Response.json({ error: "Provide property_id (digits), matterport_model_id (11 alphanumeric characters), name, and optional address." }, { status: 400 });
  }
  try {
    const result = await addProperty(input);
    return Response.json({ ...result, scene_url: `/scene/${result.property.property_id}` }, { status: result.created ? 201 : 200 });
  } catch {
    return Response.json({ error: "Could not save the property. Check the Supabase configuration." }, { status: 503 });
  }
}
