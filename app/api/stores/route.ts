import { getRepo } from "@/lib/db/repo";

// GET /api/stores — list stores for the shopper store picker.
export async function GET() {
  const stores = await getRepo().listStores();
  return Response.json({ stores });
}
