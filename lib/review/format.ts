// Display helpers shared by staff screens, the review API and audit text. Pure, safe on client and server.
import { DEMO_SHELVES, DEMO_STORE } from "../seed/demo-store";
import type { ObservationCandidate, PublishedProduct, ReviewStatus, Shelf, ShelfLevel } from "../types";

export const LEVELS: ShelfLevel[] = ["top", "upper", "middle", "lower", "bottom"];

/** Shelf catalog for the demo store. Shelf IDs are stable across floor plan versions. */
export interface CatalogShelf extends Shelf {
  storeId: string;
}
export const SHELF_CATALOG: CatalogShelf[] = DEMO_SHELVES.map((s) => ({ ...s, storeId: DEMO_STORE.id }));

export const shelfOf = (id: string | null | undefined): CatalogShelf | undefined =>
  id ? SHELF_CATALOG.find((s) => s.id === id) : undefined;

export const STATUS_TXT: Record<ReviewStatus, string> = {
  NEEDS_REVIEW: "Needs review",
  ACCEPTED: "Approved",
  EDITED: "Approved with edits",
  REJECTED: "Rejected",
  NEEDS_RESCAN: "Rescan requested",
};
export const STATUS_MARK: Record<ReviewStatus, string> = { NEEDS_REVIEW: "●", ACCEPTED: "✓", EDITED: "✓", REJECTED: "✕", NEEDS_RESCAN: "↻" };
export const SRC = { shopper: "Shopper sighting", ai: "AI vision suggestion" } as const;

export const norm = (s: string | null | undefined) =>
  (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export const titleOf = (c: Pick<ObservationCandidate, "brand" | "name">) =>
  [c.brand, c.name].filter(Boolean).join(" ") || "Unidentified product";

type Loc = { shelfId: string; level: ShelfLevel | null | "" };

export function locLongOf({ shelfId, level }: Loc): string {
  const s = shelfOf(shelfId);
  if (!s) return "Location unknown";
  return `Aisle ${s.aisle}, Section ${s.section}${level ? `, ${level} shelf` : ""}`;
}
export const locLong = (p: PublishedProduct) => locLongOf(p.location);
export function locShort(p: PublishedProduct): string {
  const s = shelfOf(p.location.shelfId);
  return s ? `A${s.aisle} · S${s.section} · ${p.location.level ?? "—"}` : "No shelf";
}

export const brandSize = (p: { brand: string | null; size: string | null }) => [p.brand, p.size].filter(Boolean).join(" · ");
export const spoken = (p: { brand: string | null; name: string; size: string | null }) =>
  `${p.brand ? p.brand + " " : ""}${p.name}${p.size ? ", " + p.size : ""}`;

export function candLoc(c: Pick<ObservationCandidate, "shelf" | "aisle" | "level">): string {
  const s = shelfOf(c.shelf);
  if (s) return `Aisle ${s.aisle}, Section ${s.section}${c.level ? ", " + c.level + " shelf" : ""}`;
  return c.aisle ? `Aisle ${c.aisle}, no exact shelf` : "Location unknown";
}
export const candStr = (c: ObservationCandidate) =>
  [c.brand, c.name || "Unidentified product", c.variant, c.size].filter(Boolean).join(" · ") + " — " + candLoc(c);

export const fmt = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
