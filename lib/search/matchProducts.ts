import type { Product } from "./types";

// Phrases people say around the product name. Stripped before matching ("where can I find almond milk" → "almond milk").
const FILLER = [
  "where can i find", "where do i find", "where is", "where are", "can you find", "help me find", "i am looking for",
  "i'm looking for", "im looking for", "looking for", "i need", "i want", "find me", "find", "get me", "take me to",
  "some", "a", "an", "the", "please",
];

export function normalize(text: string): string {
  let s = ` ${text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")} `;
  s = s.replace(/[’']/g, "").replace(/[^a-z0-9%]+/g, " ");
  // Longest phrases first so "where can i find" wins over "find".
  for (const f of [...FILLER].sort((a, b) => b.length - a.length)) {
    s = s.replaceAll(` ${f} `, " ");
  }
  return s.trim().replace(/\s+/g, " ");
}

/** Crude singularization so "eggs" matches "egg" and "bananas" matches "banana". */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 3 && token.endsWith("es") && /(ch|sh|x|ss)es$/.test(token)) return token.slice(0, -2);
  if (token.length > 2 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function tokens(s: string): string[] {
  return normalize(s).split(" ").filter(Boolean).map(stem);
}

export interface ScoredProduct<P extends Product> {
  product: P;
  score: number;
}

/**
 * Score: 100 exact name/alias, 80 all query tokens appear in one name/alias, 60 all tokens appear across
 * name+brand+variant+aliases, otherwise partial overlap ≤ 40. Results below 25 are dropped.
 */
export function scoreProduct(query: string, p: Product): number {
  const q = tokens(query);
  if (q.length === 0) return 0;
  const qJoined = q.join(" ");
  const phrases = [p.name, ...p.aliases].map((s) => tokens(s));

  if (phrases.some((t) => t.join(" ") === qJoined)) return 100;
  if (phrases.some((t) => q.every((w) => t.includes(w)))) return 80;

  const all = new Set([p.name, p.brand ?? "", p.variant ?? "", p.size ?? "", ...p.aliases].flatMap(tokens));
  const hits = q.filter((w) => all.has(w)).length;
  if (hits === q.length) return 60;
  return Math.round((hits / q.length) * 40);
}

export function searchProducts<P extends Product>(query: string, products: P[], limit = 8): ScoredProduct<P>[] {
  return products
    .map((product) => ({ product, score: scoreProduct(query, product) }))
    .filter((r) => r.score >= 25)
    .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name))
    .slice(0, limit);
}

export type Resolution<P extends Product> =
  | { status: "MATCH"; product: P }
  | { status: "AMBIGUOUS"; options: P[] }
  | { status: "NO_MATCH" };

/**
 * Decide whether the shopper's request names one product. If several products share the top score
 * (e.g. two almond milks), the shopper must choose — we never guess a variant.
 */
export function resolveProduct<P extends Product>(query: string, products: P[]): Resolution<P> {
  const results = searchProducts(query, products);
  if (results.length === 0) return { status: "NO_MATCH" };
  const top = results[0].score;
  const tied = results.filter((r) => r.score === top);
  if (tied.length === 1 && (results.length === 1 || top - results[1].score >= 20 || top === 100)) {
    return { status: "MATCH", product: tied[0].product };
  }
  return { status: "AMBIGUOUS", options: (tied.length > 1 ? tied : results.slice(0, 4)).map((r) => r.product) };
}

/** Spoken description used when listing choices, e.g. "Silk Unsweetened Almond Milk, 64 oz". */
export function describeProduct(p: Product): string {
  const name = p.brand && !p.name.toLowerCase().includes(p.brand.toLowerCase()) ? `${p.brand} ${p.name}` : p.name;
  return p.size ? `${name}, ${p.size}` : name;
}
