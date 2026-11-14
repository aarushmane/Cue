// Publish checklist for an observation review. The same function runs in the Review UI and, again,
// on the server inside POST /api/observations/:id/review before anything is written.
import { regionOf } from "../map/graph";
import type { FloorPlan, Observation, Product, ReviewDraft } from "../types";
import { DEMO_STORE } from "../seed/demo-store";
import { LEVELS, STATUS_TXT, shelfOf } from "./format";

export type CheckKey = "info" | "id" | "match" | "shelf" | "loc" | "store" | "nav" | "status";

export interface ReviewCheck {
  k: CheckKey;
  ok: boolean;
  label: string;
  fix: string;
}

const STORE_NAMES: Record<string, string> = { [DEMO_STORE.id]: DEMO_STORE.name };

export function validate(
  o: Pick<Observation, "storeId" | "status">,
  d: ReviewDraft,
  products: Pick<Product, "id">[],
  map: FloorPlan | null,
): ReviewCheck[] {
  const sh = shelfOf(d.shelf);
  const miss = [
    !d.name.trim() && "product name",
    !d.category && "category",
    !(d.size.trim() || d.variant.trim()) && "size or variant",
  ].filter(Boolean);
  const target = d.match && d.match !== "new" ? products.find((p) => p.id === d.match) : null;
  const inAisle = !!sh && sh.aisle === d.aisle;
  const region = sh && map ? regionOf(map, sh.id) : null;
  const navOk = !!region && !!region.anchor && !!map && map.nodes.some((n) => n.id === region.anchor);
  const v = map?.version ?? 0;
  return [
    { k: "info", ok: !miss.length, label: "Product name and identifying details complete", fix: `Missing: ${miss.join(", ")}.` },
    { k: "id", ok: !!d.idOk, label: "Product identity verified", fix: "Check “I have verified the product identity.”" },
    { k: "match", ok: d.match === "new" || !!target, label: "Checked against existing inventory", fix: "Choose the matching inventory product, or confirm it is a new product." },
    {
      k: "shelf", ok: inAisle && (LEVELS as string[]).includes(d.level), label: "Exact aisle, shelf section and level selected",
      fix: !d.aisle
        ? "No shelf chosen yet. The location is unknown or approximate. Select an exact aisle and shelf from the store map, or request a rescan."
        : !d.shelf ? `No shelf chosen yet. Select a shelf section in Aisle ${d.aisle}.`
        : !inAisle ? `Shelf ${d.shelf} is not in Aisle ${d.aisle}. Select a shelf section in this aisle.` : "Select the shelf level.",
    },
    { k: "loc", ok: !!d.locOk, label: "Exact shelf location verified", fix: "Check “I have verified the exact shelf location.”" },
    {
      k: "store", ok: !!sh && sh.storeId === o.storeId, label: `Shelf belongs to ${STORE_NAMES[o.storeId] ?? "this store"}`,
      fix: sh ? "This shelf belongs to a different store map." : "Select a shelf first.",
    },
    {
      k: "nav", ok: navOk, label: "Shelf has a navigation destination",
      fix: !sh ? "Select a shelf first." : !region ? `${sh.id} is not placed on published floor plan v${v}.` : `${sh.id} has no walkable approach point on published floor plan v${v}.`,
    },
    { k: "status", ok: o.status === "NEEDS_REVIEW", label: "Observation not already processed", fix: `This observation is already ${STATUS_TXT[o.status].toLowerCase()}.` },
  ];
}

/** Fresh review draft from an observation (or its saved details). */
export function draftFromObservation(o: Observation): ReviewDraft {
  return o.saved ? { ...o.saved, obsVersion: o.version } : { ...o.candidate, match: "", targetVersion: null, idOk: false, locOk: false, obsVersion: o.version };
}
