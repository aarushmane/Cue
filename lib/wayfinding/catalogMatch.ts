// Matching a visitor's question against the scan's product catalogue (catalog.ts). Pure, so it can be unit tested.
import { normalize } from "../search/matchProducts";
import type { SceneItem } from "./types";

// Category words visitors use → categories the catalogue may record.
const CATEGORY_WORDS: Record<string, string[]> = {
  candy: ["candy", "chocolate", "gum", "mints", "lollipop", "sweets", "confectionery", "gummies"],
  sweet: ["candy", "chocolate", "gum", "mints", "lollipop", "sweets", "confectionery", "gummies"],
  chocolate: ["chocolate"],
  chip: ["chips", "tortilla chips", "potato chips", "crisps", "corn chips", "puffs"],
  crisp: ["chips", "crisps", "potato chips"],
  snack: ["chips", "snacks", "crackers", "popcorn", "pretzels", "jerky", "nuts", "puffs"],
  soda: ["soda", "soft drink", "cola", "pop"],
  pop: ["soda", "soft drink", "cola", "pop"],
  drink: ["soda", "soft drink", "energy drink", "water", "juice", "sports drink", "tea", "coffee", "drinks", "beverage"],
  water: ["water"],
  juice: ["juice"],
  energy: ["energy drink"],
  cookie: ["cookies", "biscuits"],
  cake: ["snack cakes", "cakes", "pastries", "baked goods"],
  pastry: ["snack cakes", "pastries", "baked goods"],
  bread: ["bread", "baked goods"],
  cereal: ["cereal"],
  jerky: ["jerky", "meat snacks"],
  nut: ["nuts", "seeds"],
  gum: ["gum"],
  beer: ["beer"],
  alcohol: ["beer", "wine", "liquor"],
  detergent: ["detergent", "laundry detergent"],
  laundry: ["detergent", "laundry detergent"],
  soap: ["soap", "detergent"],
  noodle: ["noodles", "ramen", "instant noodles"],
  ramen: ["noodles", "ramen", "instant noodles"],
  soup: ["soup", "noodles"],
  cracker: ["crackers"],
  tea: ["tea"],
};

const singularWords = (q: string) => normalize(q).split(" ").map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));

/** True when the question names a kind of product ("chips", "something to drink") rather than a brand. */
export function isCategoryQuery(query: string): boolean {
  return singularWords(query).some((w) => w in CATEGORY_WORDS);
}

/**
 * Places of a whole category ("chips", "candy"). A category recorded exactly as asked wins ("snack cakes" does not
 * pull in chips through "snack").
 */
export function matchCategory(items: SceneItem[], query: string): SceneItem[] {
  const phrase = singularWords(query).join(" ");
  const exact = items.some((i) => i.category && singularWords(i.category).join(" ") === phrase);
  // Asked exactly as recorded: that category plus the phrase's own synonyms ("candy" keeps chocolate), not the
  // synonyms of its separate words.
  const wanted = new Set(exact ? [phrase, ...(CATEGORY_WORDS[phrase] ?? [])] : singularWords(query).flatMap((w) => CATEGORY_WORDS[w] ?? []));
  if (!wanted.size) return [];
  return items.filter((i) => {
    if (exact && i.category && singularWords(i.category).join(" ") === phrase) return true;
    const c = normalize(i.category ?? "");
    return c && [...wanted].some((w) => c === w || c.includes(w) || w.includes(c));
  });
}

/**
 * Catalogue entries for a brand or product question. Pure. Scores: exact brand or product 3; a product name that
 * contains the whole question 2.5 ("hot cheetos" → "Flamin' Hot Cheetos"); a brand named inside the question 2
 * ("hot cheetos" → "Cheetos"). Category-only matches ("chips") are left to the photo search. Returns every place
 * with the best score, so the caller can route to the nearest.
 */
export function matchCatalog(items: SceneItem[], query: string): SceneItem[] {
  const q = normalize(query);
  if (q.length < 2) return [];
  const qc = q.replace(/ /g, "");
  const singular = (s: string) => (s.length > 3 && s.endsWith("s") ? s.slice(0, -1) : s);
  const score = (item: SceneItem) => {
    let best = 0;
    for (const [i, raw] of [item.brand ?? item.name, ...(item.aliases ?? [])].entries()) {
      const n = normalize(raw), nc = n.replace(/ /g, "");
      if (nc.length < 2) continue;
      if (nc === qc || singular(nc) === singular(qc)) best = Math.max(best, 3);
      else if (qc.length >= 3 && nc.includes(qc)) best = Math.max(best, 2.5);
      else if (i === 0 && nc.length >= 3 && qc.includes(nc)) best = Math.max(best, 2);
    }
    return best;
  };
  const scored = items.map((item) => ({ item, s: score(item) })).filter((x) => x.s >= 2);
  const top = Math.max(0, ...scored.map((x) => x.s));
  return scored.filter((x) => x.s === top).map((x) => x.item);
}
