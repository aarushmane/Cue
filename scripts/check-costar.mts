// Preflight for the CoStar / LangChain tracks. Run: npm run check:costar
// Checks (never prints secret values):
//   1. Which keys are set in .env.local
//   2. data/models_index.csv has the two retail demo properties
//   3. The Matterport key works, and whether it returns `locations.neighbors` (real navigation edges) for each model
//   4. Each model has a georeferenced floor plan image (for the graph-over-plan screenshot)
//   5. Vexcel covers each property (tiny 64 px ortho extract)
//   6. LangSmith tracing is on (for the trace screenshot)
// Self-contained on purpose: Node runs this .mts directly, and lib/ uses extensionless imports Node can't resolve.
import { existsSync, readFileSync } from "node:fs";

const MODELS = [
  { label: "337 S Broadway, LA", costarId: "9560712", sid: "6FNMVoyPrL1", lat: 34.0502181, lon: -118.2492997 },
  { label: "941 Towne Ave, LA", costarId: null, sid: "bP9oEnqmeie", lat: 34.0348917, lon: -118.2497237 },
];

const env = (k: string) => (process.env[k] ?? "").trim();
const ok = (s: string) => console.log(`  ✅ ${s}`);
const warn = (s: string) => console.log(`  ⚠️  ${s}`);
const bad = (s: string) => console.log(`  ❌ ${s}`);
const todo: string[] = [];
// Print only fixed diagnostic categories: upstream errors can contain signed URLs or credentials.
const safeError = (e: unknown) => {
  const message = e instanceof Error ? e.message : "";
  if (/^HTTP \d{3}( \(key rejected\))?$/.test(message)) return message;
  if (message === "GraphQL query rejected (check field access/schema)") return message;
  return "request failed (check credentials, network, and API schema)";
};

console.log("\n1. Keys in .env.local");
const keys = [
  ["MATTERPORT_API_KEY", "Matterport (run /costar-keys in the track Discord)"],
  ["MATTERPORT_API_TOKEN", "Matterport token"],
  ["VEXCEL_API_KEY", "Vexcel aerial"],
  ["GEMINI_API_KEY", "Gemini (or ANTHROPIC_API_KEY)"],
  ["ANTHROPIC_API_KEY", "Anthropic (optional if Gemini is set)"],
  ["LANGSMITH_API_KEY", "LangSmith trace for the LangChain track"],
] as const;
for (const [k, why] of keys) {
  if (env(k)) ok(`${k} set`);
  else if (k === "ANTHROPIC_API_KEY" || (k === "GEMINI_API_KEY" && env("ANTHROPIC_API_KEY"))) warn(`${k} not set (${why})`);
  else {
    bad(`${k} missing: ${why}`);
    todo.push(`Set ${k}`);
  }
}

console.log("\n2. models_index.csv");
const csvPath = env("MATTERPORT_INDEX_CSV") || "data/models_index.csv";
if (!existsSync(csvPath)) {
  bad(`${csvPath} not found (download it from the track quickstart page)`);
  todo.push("Download models_index.csv into data/");
} else {
  const text = readFileSync(csvPath, "utf8");
  for (const m of MODELS) {
    if (text.includes(m.sid)) ok(`${m.label}: ${m.sid}${m.costarId ? ` (CoStar ${m.costarId})` : ""}`);
    else {
      bad(`${m.label}: ${m.sid} not in the index`);
      todo.push(`Check models_index.csv for ${m.sid}`);
    }
  }
}

async function matterport<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const auth = Buffer.from(`${env("MATTERPORT_API_KEY")}:${env("MATTERPORT_API_TOKEN")}`).toString("base64");
  const res = await fetch("https://api.matterport.com/api/models/graph", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}${res.status === 401 || res.status === 403 ? " (key rejected)" : ""}`);
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) throw new Error("GraphQL query rejected (check field access/schema)");
  return body.data as T;
}

type Loc = { id: string; neighbors?: string[] | null; floor?: { id: string } | null };
type Plan = { url?: string; width?: number; height?: number; format?: string; flags?: string[]; resolution?: number; origin?: { x: number; y: number } | null };

console.log("\n3–4. Matterport: navigation neighbors and floor plans");
if (!env("MATTERPORT_API_KEY") || !env("MATTERPORT_API_TOKEN")) {
  warn("skipped: no Matterport key");
} else {
  for (const m of MODELS) {
    try {
      const d = await matterport<{ model: { name: string; locations: Loc[] } | null }>(
        `query N($id: ID!) { model(id: $id) { name locations { id neighbors floor { id } } } }`,
        { id: m.sid },
      );
      if (!d.model) throw new Error("model not found for this key");
      const locs = d.model.locations ?? [];
      const withN = locs.filter((l) => (l.neighbors?.length ?? 0) > 0).length;
      const floors = new Set(locs.map((l) => l.floor?.id).filter(Boolean)).size;
      if (withN > 0) ok(`${m.label}: ${locs.length} locations on ${floors} floor(s), ${withN} with neighbors → real Matterport navigation edges`);
      else {
        warn(`${m.label}: ${locs.length} locations, NO neighbors → import uses wall-checked proximity edges (say so in the pitch)`);
        todo.push(`Mention proximity-edge fallback for ${m.label} in the pitch`);
      }
    } catch (e) {
      bad(`${m.label}: ${safeError(e)}`);
      todo.push(`Fix Matterport access for ${m.sid}`);
    }
    try {
      const d = await matterport<{ model: { assets: { floorplans: Plan[] } } }>(
        `query P($id: ID!) { model(id: $id) { assets { floorplans(provider: "matterport") { format flags url width height resolution origin { x y } } } } }`,
        { id: m.sid },
      );
      const plans = d.model?.assets?.floorplans ?? [];
      const usable = plans.filter((p) => p.format?.toLowerCase() === "jpg" && (p.flags ?? []).includes("photogramy") && p.url && (p.width ?? 0) > 0 && (p.height ?? 0) > 0 && (p.resolution ?? 0) > 0 && p.origin?.x != null && p.origin?.y != null);
      if (usable.length) ok(`${m.label}: ${usable.length} georeferenced floor plan image(s)`);
      else {
        warn(`${m.label}: no georeferenced floor plan (${plans.length} plan assets) → the graph draws without a background`);
        todo.push(`No plan image for ${m.label}: screenshot the graph alone or overlay manually`);
      }
    } catch (e) {
      warn(`${m.label}: floor plan query failed (${safeError(e)})`);
      todo.push(`Verify floor plan for ${m.sid}; use graph-only screenshot until confirmed`);
    }
  }
}

console.log("\n5. Vexcel aerial coverage");
if (!env("VEXCEL_API_KEY")) {
  warn("skipped: no Vexcel key");
} else {
  const M = 111_320;
  for (const m of MODELS) {
    const half = 40;
    const dlat = half / M;
    const dlon = half / (M * Math.cos((m.lat * Math.PI) / 180));
    const [w, e, s, n] = [m.lon - dlon, m.lon + dlon, m.lat - dlat, m.lat + dlat];
    try {
      const res = await fetch("https://api.vexcelgroup.com/v2/ortho/extract", {
        method: "POST",
        headers: { "content-type": "application/json", "X-API-KEY": env("VEXCEL_API_KEY") },
        body: JSON.stringify({
          wkt: `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`, srid: 4326, layer: "urban,urban-r,wide-area,urban-g",
          crop: "bounding_box", "image-format": "jpeg", "destination-dimensions": "64,64", attribution: "false",
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok && /^image\/(jpeg|png|webp)(;|$)/i.test(res.headers.get("content-type") ?? "") && (await res.arrayBuffer()).byteLength > 0) ok(`${m.label}: ortho available`);
      else if (res.status === 403) {
        warn(`${m.label}: Vexcel denied the request (403: check coverage AND key permissions)`);
        todo.push(`Confirm Vexcel coverage/permissions for ${m.sid}; staff must inspect the approach in person`);
      }
      else {
        bad(`${m.label}: Vexcel HTTP ${res.status} (no usable image)`);
        todo.push("Fix Vexcel access");
      }
    } catch (e) {
      bad(`${m.label}: ${safeError(e)}`);
      todo.push(`Verify Vexcel access for ${m.sid}; staff must inspect the approach in person`);
    }
  }
}

console.log("\n6. LangSmith");
if (env("LANGSMITH_TRACING") === "true" && env("LANGSMITH_API_KEY")) ok("tracing on: the next onboarding run appears in LangSmith");
else {
  warn("tracing off: set LANGSMITH_TRACING=true and LANGSMITH_API_KEY, then run one onboarding for the screenshot");
  todo.push("Turn on LangSmith tracing and capture one onboarding trace");
}

console.log(todo.length ? `\nTo do:\n${todo.map((t) => `  - ${t}`).join("\n")}\n` : "\nAll checks passed.\n");

// Default mode is advisory; CI can explicitly require every live check to be ready.
if (process.argv.includes("--strict") && todo.length) process.exitCode = 1;
