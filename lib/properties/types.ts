export type PropertyInput = {
  property_id: string;
  matterport_model_id: string;
  name: string;
  address: string | null;
};

export type Property = PropertyInput & { id: string; created_at: string };

export function parseProperty(input: unknown): PropertyInput | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;
  if (typeof value.property_id !== "string" || !/^[0-9]{1,20}$/.test(value.property_id)) return null;
  if (typeof value.matterport_model_id !== "string" || !/^[a-zA-Z0-9]{11}$/.test(value.matterport_model_id)) return null;
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 200) return null;
  if (value.address != null && (typeof value.address !== "string" || value.address.length > 500)) return null;
  return {
    property_id: value.property_id,
    matterport_model_id: value.matterport_model_id,
    name: value.name.trim(),
    address: typeof value.address === "string" ? value.address.trim() || null : null,
  };
}
