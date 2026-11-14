// Request schemas for staff and shopper writes (untrusted client input). Shared by the demo adapter
// (lib/demo/adapter.ts) and the real routes under app/api, so both validate exactly the same shapes.
import { z } from "zod";
import { LEVELS } from "../review/format";
import type { ShelfLevel } from "../types";

export const Level = z.enum(LEVELS as [ShelfLevel, ...ShelfLevel[]]);
const Str = z.string().max(200);
export const Candidate = z.object({
  name: Str, brand: Str, category: Str, size: Str, variant: Str, aisle: z.string().max(4), shelf: z.string().max(40),
  level: z.union([Level, z.literal("")]),
});
export const Draft = Candidate.extend({
  match: z.string().max(40), targetVersion: z.number().int().nullable(), idOk: z.boolean(), locOk: z.boolean(),
  idReset: z.boolean().optional(), locReset: z.boolean().optional(), obsVersion: z.number().int(),
});
const Point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const Plan = z.object({
  mapId: z.string().max(60),
  version: z.number().int(),
  // The background is a local object URL in the demo (POST /api/media is not connected), so only its reference travels.
  plan: z.object({ url: z.string().max(2000), name: z.string().max(200), kind: z.enum(["image", "pdf"]) }).nullable(),
  aspect: z.number().positive().max(20),
  nodes: z.array(Point.extend({ id: z.string().max(20), kind: z.enum(["entrance", "service", "walk", "junction", "shelf_approach", "aisle_marker"]) })).max(500),
  edges: z.array(z.tuple([z.string().max(20), z.string().max(20)])).max(2000),
  shelves: z.array(Point.extend({ key: z.string().max(40), id: z.string().max(40), w: z.number().min(0).max(1), h: z.number().min(0).max(1), anchor: z.string().max(20) })).max(500),
  landmarks: z.array(Point.extend({ id: z.string().max(20), label: z.string().max(300), verified: z.boolean() })).max(200),
});

