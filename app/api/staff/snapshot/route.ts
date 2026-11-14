import { requireStaff } from "@/lib/auth/requireStaff";
import { readSnapshot, staffStores } from "@/lib/staff/reads";
import { json } from "@/lib/staff/readRoute";

// GET /api/staff/snapshot[?store_id=] — staff only. Everything the manager screens read (products, observations,
// Activity, floor plans) for one store, in one response: the reads of GET /api/audit, /api/observations and
// /api/maps plus the published products. Without store_id: the first store the signed-in employee works at.
export async function GET(request: Request) {
  const who = await requireStaff(request, null);
  if (!who.ok) return json({ error: who.error }, who.status);
  try {
    const stores = await staffStores(who);
    const wanted = new URL(request.url).searchParams.get("store_id");
    const store = wanted ? stores.find((s) => s.id === wanted) : stores[0];
    if (!store) {
      return json({ code: "FORBIDDEN", error: wanted ? "You are not staff for this store." : "Your account isn't staff for any store yet." }, 403);
    }
    // `stores` comes from the caller's own store_staff rows, so this is the same per-store check requireStaff makes.
    const snapshot = await readSnapshot(store, who);
    return snapshot ? json({ snapshot }) : json({ code: "NOT_FOUND", error: "This store has no published floor plan yet." }, 404);
  } catch {
    return json({ code: "DB_ERROR", error: "The database request failed. Try again." }, 500);
  }
}
