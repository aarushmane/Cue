// CoStar data kit (Houston + Los Angeles extract). Handed out in the track Discord via /costar-keys as a
// password-protected zip. Unzip it locally and set COSTAR_KIT_DIR to that folder (never commit it).
// The quickstart says commercial records live under commercial-property/ with the property id in the file
// name; that layout is not yet verified, so this reader is defensive and returns null when unsure.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export function costarKitConfigured(): boolean {
  return Boolean(process.env.COSTAR_KIT_DIR);
}

async function* walk(dir: string, depth = 0): AsyncGenerator<string> {
  if (depth > 4) return;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else yield p;
  }
}

/** Trim a record so it fits in model context: drop long arrays/strings, keep scalars and short lists. */
function trim(v: unknown, depth = 0): unknown {
  if (depth > 3) return undefined;
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 10).map((x) => trim(x, depth + 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(0, 60).map(([k, x]) => [k, trim(x, depth + 1)]));
  return v;
}

export async function costarRecord(propertyId: string): Promise<Record<string, unknown> | null> {
  const dir = process.env.COSTAR_KIT_DIR;
  if (!dir || !/^\d+$/.test(propertyId)) return null;
  const re = new RegExp(`(^|[^0-9])${propertyId}([^0-9]|$)`);
  for await (const file of walk(dir)) {
    if (!file.includes("commercial") || !file.endsWith(".json") || !re.test(path.basename(file))) continue;
    try {
      return trim(JSON.parse(await readFile(file, "utf8"))) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

/** Best-effort tenant names from an unknown record shape: any array under a key containing "tenant". */
export function tenantsFrom(record: Record<string, unknown> | null): string[] {
  if (!record) return [];
  for (const [k, v] of Object.entries(record)) {
    if (!/tenant/i.test(k) || !Array.isArray(v)) continue;
    return v
      .map((t) => (typeof t === "string" ? t : t && typeof t === "object" ? String((t as Record<string, unknown>).name ?? (t as Record<string, unknown>).tenant_name ?? "") : ""))
      .filter(Boolean)
      .slice(0, 20);
  }
  return [];
}
