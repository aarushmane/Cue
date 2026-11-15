import { readMaps } from "@/lib/staff/reads";
import { json, staffForStoreParam } from "@/lib/staff/readRoute";

// GET /api/maps?store_id= — staff only. { maps: { published, draft, draftSavedAt } } in the editor's FloorPlan format.
export async function GET(request: Request) {
  const ctx = await staffForStoreParam(request);
  if (ctx instanceof Response) return ctx;
  try {
    const maps = await readMaps(ctx.storeId);
    return maps ? json({ maps }) : json({ code: "NOT_FOUND", error: "This store has no published floor plan." }, 404);
  } catch {
    return json({ code: "DB_ERROR", error: "The database request failed. Try again." }, 500);
  }
}
