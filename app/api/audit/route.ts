import { readAudit } from "@/lib/staff/reads";
import { json, staffForStoreParam } from "@/lib/staff/readRoute";

// GET /api/audit?store_id= — staff only. The store's Activity feed, newest first (docs/contracts.md).
export async function GET(request: Request) {
  const ctx = await staffForStoreParam(request);
  if (ctx instanceof Response) return ctx;
  try {
    return json({ events: await readAudit(ctx.storeId) });
  } catch {
    return json({ code: "DB_ERROR", error: "The database request failed. Try again." }, 500);
  }
}
