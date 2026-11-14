import type { Product } from "../types";
import { norm } from "./format";

const tokens = (s: string) => norm(s).split(" ").filter((w) => w.length > 1);

/**
 * Possible existing products for an observation. Token overlap of brand+name against product brand/name/aliases
 * (≥2 shared tokens or ≥50% of the observation's tokens), plus any suggested match. Similar names only surface
 * candidates: a merge always needs an explicit employee choice, never an automatic one.
 */
export function findMatches<P extends Product>(
  d: { brand: string; name: string },
  products: P[],
  suggested?: string,
  limit = 3,
): P[] {
  const dt = [...new Set(tokens(`${d.brand || ""} ${d.name}`))];
  return products
    .map((p) => {
      const pt = new Set(tokens([p.brand ?? "", p.name, ...p.aliases].join(" ")));
      const ov = dt.filter((w) => pt.has(w)).length;
      return { p, ov, sc: dt.length ? ov / dt.length : 0 };
    })
    .filter((x) => x.p.id === suggested || x.ov >= 2 || x.sc >= 0.5)
    .sort((a, b) => b.sc - a.sc)
    .slice(0, limit)
    .map((x) => x.p);
}
