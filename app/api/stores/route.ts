import { connection } from "next/server";
import { getRepo } from "@/lib/db/repo";

// GET /api/stores — list stores for the shopper store picker. Always read at request time (stores can be added).
export async function GET() {
  await connection();
  const stores = await getRepo().listStores();
  return Response.json({ stores });
}
