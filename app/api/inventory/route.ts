import { connection } from "next/server";
import { requireStaff } from "@/lib/auth/requireStaff";
import { listInventory, listSuggestions } from "@/lib/inventory/store";

// GET /api/inventory?store_id= — staff view of the published inventory with shopper-sighting freshness,
// plus how many suggestions wait for review.
export async function GET(request: Request) {
  await connection();
  const storeId = new URL(request.url).searchParams.get("store_id");
  if (!storeId) return Response.json({ error: "store_id is required" }, { status: 400 });
  const auth = await requireStaff(request, storeId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });

  const [items, pending] = await Promise.all([listInventory(storeId), listSuggestions(storeId, ["PENDING"])]);
  items.sort((a, b) => a.aisle.localeCompare(b.aisle) || a.section.localeCompare(b.section) || a.name.localeCompare(b.name));
  return Response.json({ items, pending_count: pending.length });
}
