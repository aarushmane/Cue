// models_index.csv from the track quickstart: one row per Matterport model the hackathon keys can see, with the
// CoStar property id where known. The Model API has no geo or CoStar-id search, so this file is the join.
// Download it from the quickstart page into data/models_index.csv (git-ignored: hackathon use only).
import { readFile } from "node:fs/promises";
import path from "node:path";

export interface IndexRow {
  sid: string;
  name: string;
  segment: string;
  lat: number;
  lon: number;
  address: string;
  city: string;
  costar_property_id: string;
  internal_id: string;
  pano_count: number;
  floor_count: number;
}

/** Minimal RFC 4180 parser (quoted fields, doubled quotes, commas and newlines inside quotes). Exported for tests. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || r[0] !== "");
}

let cache: IndexRow[] | null = null;

export async function loadIndex(): Promise<IndexRow[]> {
  if (cache) return cache;
  const file = process.env.MATTERPORT_INDEX_CSV || path.join(process.cwd(), "data", "models_index.csv");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    cache = [];
    return cache;
  }
  const [header, ...rows] = parseCsv(text);
  const col = (name: string) => header.indexOf(name);
  const get = (r: string[], name: string) => (col(name) >= 0 ? r[col(name)] ?? "" : "");
  cache = rows.map((r) => ({
    sid: get(r, "sid"),
    name: get(r, "name"),
    segment: get(r, "segment"),
    lat: Number(get(r, "lat")),
    lon: Number(get(r, "lon")),
    address: get(r, "address"),
    city: get(r, "city"),
    costar_property_id: get(r, "costar_property_id"),
    internal_id: get(r, "internal_id"),
    pano_count: Number(get(r, "pano_count")) || 0,
    floor_count: Number(get(r, "floor_count")) || 0,
  }));
  return cache;
}

export async function findByCostarId(costarId: string): Promise<IndexRow | null> {
  // One CoStar property can have several models (e.g. a lobby and a suite): prefer the one with the most panos.
  const rows = (await loadIndex()).filter((r) => r.costar_property_id === costarId);
  return rows.sort((a, b) => b.pano_count - a.pano_count)[0] ?? null;
}

export async function findBySid(sid: string): Promise<IndexRow | null> {
  return (await loadIndex()).find((r) => r.sid === sid) ?? null;
}
