import { connection } from "next/server";
import { z } from "zod";
import { requireStaff } from "@/lib/auth/requireStaff";
import { listSuggestions } from "@/lib/inventory/store";

const Status = z.enum(["COLLECTING", "PENDING", "APPROVED", "REJECTED", "AUTO_RESOLVED"]);

// GET /api/inventory/suggestions?store_id=&status=PENDING[,COLLECTING...] — the staff review queue.
export async function GET(request: Request) {
  await connection();
  const params = new URL(request.url).searchParams;
  const storeId = params.get("store_id");
  if (!storeId) return Response.json({ error: "store_id is required" }, { status: 400 });
  const statuses = z.array(Status).safeParse((params.get("status") ?? "PENDING").split(","));
  if (!statuses.success) return Response.json({ error: "Unknown status" }, { status: 400 });
  const auth = await requireStaff(request, storeId);
  if (!auth.ok) return Response.json({ error: auth.error }, { status: auth.status });
  return Response.json({ suggestions: await listSuggestions(storeId, statuses.data) });
}
