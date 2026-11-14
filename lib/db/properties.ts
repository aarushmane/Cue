import "server-only";
import { getDb } from "./client";
import type { Property, PropertyInput } from "@/lib/properties/types";

// Reuse the existing stores table. Do not migrate or reset the live database.
const columns = "id, property_id:costar_property_id, matterport_model_id, name, address, created_at";

export async function findProperty(propertyId: string): Promise<Property | null> {
  const { data, error } = await getDb("read")
    .from("stores")
    .select(columns)
    .eq("costar_property_id", propertyId)
    .not("matterport_model_id", "is", null)
    .order("created_at", { ascending: false })
    .order("id")
    .limit(1)
    .maybeSingle<Property>();
  if (error) throw new Error("Could not read the property from Supabase.");
  return data;
}

export async function addProperty(input: PropertyInput): Promise<{ property: Property; created: boolean }> {
  const db = getDb("write");
  // Deterministic ID makes retries and concurrent requests safe without updating old rows.
  const id = `scene-${input.property_id}-${input.matterport_model_id}`;
  const { data, error } = await db.from("stores").insert({
    id,
    costar_property_id: input.property_id,
    matterport_model_id: input.matterport_model_id,
    name: input.name,
    address: input.address,
  }).select(columns).single<Property>();
  if (!error) return { property: data, created: true };
  if (error.code === "23505") {
    const existing = await db.from("stores").select(columns).eq("id", id).single<Property>();
    if (!existing.error && existing.data) return { property: existing.data, created: false };
  }
  throw new Error("Could not save the property in Supabase.");
}
