import { z } from "zod";

// Navigation state round-trips through the client each turn (the server is stateless, which suits Vercel).
// The server never trusts it for inventory: products and routes are always re-read from the published store.
export const ShopperNav = z.object({
  store_id: z.string().min(1).max(100),
  state: z.enum(["SEARCHING", "DESTINATION_SELECTED", "LOCATING", "ROUTING", "GUIDING", "ARRIVED", "NEEDS_HELP"]).default("SEARCHING"),
  product_id: z.string().max(100).nullable().default(null),
  candidate_product_ids: z.array(z.string().max(100)).max(8).default([]),
  current_node_id: z.string().max(100).nullable().default(null),
  position_confidence: z.enum(["CONFIRMED", "LIKELY", "UNKNOWN"]).default("UNKNOWN"),
  route_start_node_id: z.string().max(100).nullable().default(null),
  destination_shelf_id: z.string().max(100).nullable().default(null),
  step_index: z.number().int().min(0).default(0),
  prefs: z
    .object({
      verbosity: z.enum(["concise", "detailed"]).default("concise"),
      speech_rate: z.number().min(0.5).max(2).default(1),
    })
    .default({ verbosity: "concise", speech_rate: 1 }),
});
export type ShopperNav = z.infer<typeof ShopperNav>;
