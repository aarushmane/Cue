export interface Product {
  id: string;
  storeId: string;
  name: string;
  brand: string | null;
  variant: string | null;
  size: string | null;
  aliases: string[];
  /** Product type / staff-facing category, e.g. "plant-based milk". Optional so older rows stay valid. */
  category?: string | null;
  /** Optimistic-concurrency version, bumped on every staff edit or move. */
  version?: number;
}
