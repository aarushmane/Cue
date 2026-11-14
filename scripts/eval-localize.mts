// Evaluate visual localization on real venue photos.
//
//   npm run eval:localize -- [--dir data/venue-scans] [--url http://localhost:3000] [--store demo-store]
//                            [--group 1] [--prev N01] [--delay 4000] [--limit 0] [--out results.json]
//
// Folder layout: <dir>/<landmarkId>/*.jpg|.jpeg|.png|.webp (e.g. data/venue-scans/L03/aisle2-from-left.jpg).
// A folder named "none" holds photos where NO landmark is visible (they should come back UNKNOWN).
// Each request sends --group consecutive photos of one folder as one scan (1–3; the app sends 3 frames 600 ms apart).
//
// Privacy: photos are read from the folder you give and sent once to your own server. Nothing is copied, cached or
// logged; --out writes text results only. share_sightings is false, so evaluation never touches inventory.
// Quota: every request is one vision call. The free Gemini tier is rate-limited, hence the default 4 s delay.
// Self-contained on purpose (no imports from lib/): Node can't resolve lib/'s extensionless imports.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const DIR = opt("dir", "data/venue-scans");
const URL_BASE = opt("url", "http://localhost:3000").replace(/\/$/, "");
const STORE = opt("store", "demo-store");
const GROUP = Math.min(3, Math.max(1, Number(opt("group", "1")) || 1));
const PREV = opt("prev", "") || null;
const DELAY = Math.max(0, Number(opt("delay", "4000")) || 0);
const LIMIT = Math.max(0, Number(opt("limit", "0")) || 0);
const OUT = opt("out", "");

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };
const MAX_FRAME_CHARS = 2_000_000; // same cap as POST /api/localize (≈1.5 MB JPEG)
const NONE = "none";

type Result = {
  expected: string;
  files: string[];
  got: string; // landmark id or "none"
  node: string | null;
  state: "CONFIRMED" | "LIKELY" | "UNKNOWN" | "ERROR";
  evidence: string;
  ms: number;
};

if (!existsSync(DIR) || !statSync(DIR).isDirectory()) {
  console.error(`No folder ${DIR}. Create ${DIR}/<landmarkId>/*.jpg (and ${DIR}/none/ for photos with no landmark).`);
  process.exit(1);
}

// ───────────────────────────── Collect photos ─────────────────────────────
const jobs: { expected: string; files: string[] }[] = [];
for (const label of readdirSync(DIR).sort()) {
  const folder = path.join(DIR, label);
  if (!statSync(folder).isDirectory()) continue;
  const files = readdirSync(folder)
    .filter((f) => MIME[path.extname(f).toLowerCase()])
    .sort()
    .map((f) => path.join(folder, f));
  for (let i = 0; i < files.length; i += GROUP) jobs.push({ expected: label, files: files.slice(i, i + GROUP) });
}
const queue = LIMIT ? jobs.slice(0, LIMIT) : jobs;
if (!queue.length) {
  console.error(`No .jpg/.png/.webp photos under ${DIR}/<landmarkId>/.`);
  process.exit(1);
}
console.log(`${queue.length} scan(s) of ${GROUP} photo(s) from ${DIR} → ${URL_BASE}/api/localize (store ${STORE}${PREV ? `, previous node ${PREV}` : ""})\n`);

const toDataUrl = (file: string): string | null => {
  const url = `data:${MIME[path.extname(file).toLowerCase()]};base64,${readFileSync(file).toString("base64")}`;
  return url.length > MAX_FRAME_CHARS ? null : url;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────────────────────── Run ─────────────────────────────
const results: Result[] = [];
for (const [n, job] of queue.entries()) {
  if (n > 0 && DELAY) await sleep(DELAY);
  const frames: string[] = [];
  for (const f of job.files) {
    const d = toDataUrl(f);
    if (d) frames.push(d);
    else console.log(`  skip ${f}: over ~1.5 MB (resize: sips -Z 1280 "${f}")`);
  }
  if (!frames.length) continue;
  const t0 = Date.now();
  let r: Result = { expected: job.expected, files: job.files, got: NONE, node: null, state: "ERROR", evidence: "", ms: 0 };
  try {
    const res = await fetch(`${URL_BASE}/api/localize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ store_id: STORE, frames, previous_node_id: PREV, share_sightings: false }),
      signal: AbortSignal.timeout(90_000),
    });
    const body = (await res.json().catch(() => ({}))) as { confidence_state?: Result["state"]; selected_node_id?: string | null; landmark_id?: string | null; evidence?: string; error?: string };
    if (res.status === 503) {
      console.error(`\nThe server has no AI provider configured (503): ${body.evidence ?? body.error ?? ""}`);
      process.exit(1);
    }
    r = {
      ...r,
      got: body.landmark_id ?? NONE,
      node: body.selected_node_id ?? null,
      state: res.ok && body.confidence_state ? body.confidence_state : "ERROR",
      evidence: (body.evidence ?? body.error ?? `HTTP ${res.status}`).replace(/\s+/g, " ").trim(),
    };
    if (res.status === 429 || res.status === 502) await sleep(DELAY * 2); // back off on rate limits / model errors
  } catch (e) {
    r.evidence = e instanceof Error ? e.message : String(e);
  }
  r.ms = Date.now() - t0;
  results.push(r);
  const ok = r.state !== "ERROR" && r.got === r.expected && (r.expected === NONE || r.state !== "UNKNOWN");
  const mark = r.state === "ERROR" ? "!" : ok ? "✓" : "✗";
  console.log(`${mark} ${path.relative(DIR, job.files[0])}${job.files.length > 1 ? ` (+${job.files.length - 1})` : ""}  expected ${r.expected} → ${r.got} ${r.state}${r.node ? ` @${r.node}` : ""}  ${r.ms} ms`);
}

// ───────────────────────────── Report ─────────────────────────────
const done = results.filter((r) => r.state !== "ERROR");
const labels = [...new Set([...done.map((r) => r.expected), ...done.map((r) => r.got)])].sort((a, b) => (a === NONE ? 1 : b === NONE ? -1 : a.localeCompare(b)));
const pad = (s: string | number, w: number) => String(s).padStart(w);
const w = Math.max(6, ...labels.map((l) => l.length + 1));

console.log(`\nConfusion (rows = expected, columns = landmark the model picked; counts include UNKNOWN picks)`);
console.log(pad("", w) + labels.map((l) => pad(l, w)).join(""));
for (const e of labels.filter((l) => done.some((r) => r.expected === l))) {
  console.log(pad(e, w) + labels.map((g) => pad(done.filter((r) => r.expected === e && r.got === g).length || "·", w)).join(""));
}

console.log(`\nConfidence by expected landmark`);
console.log(pad("", w) + ["CONFIRMED", "LIKELY", "UNKNOWN", "correct", "wrong+sure"].map((h) => pad(h, 11)).join(""));
for (const e of labels.filter((l) => done.some((r) => r.expected === l))) {
  const rows = done.filter((r) => r.expected === e);
  const count = (st: string) => rows.filter((r) => r.state === st).length;
  const correct = rows.filter((r) => (e === NONE ? r.state === "UNKNOWN" || r.got === NONE : r.got === e && r.state !== "UNKNOWN")).length;
  // The dangerous case: a wrong landmark with enough confidence to start guidance from the wrong place.
  const wrongSure = rows.filter((r) => r.got !== e && r.got !== NONE && r.state !== "UNKNOWN").length;
  console.log(pad(e, w) + [count("CONFIRMED"), count("LIKELY"), count("UNKNOWN"), `${correct}/${rows.length}`, wrongSure].map((v) => pad(v, 11)).join(""));
}

const correctAll = done.filter((r) => (r.expected === NONE ? r.state === "UNKNOWN" || r.got === NONE : r.got === r.expected && r.state !== "UNKNOWN")).length;
const wrongSureAll = done.filter((r) => r.got !== r.expected && r.got !== NONE && r.state !== "UNKNOWN").length;
const errors = results.length - done.length;
console.log(`\nUsable and correct: ${correctAll}/${done.length}. Wrong but confident: ${wrongSureAll} (must be 0 for the demo). Errors: ${errors}.`);
if (done.length) console.log(`Median latency: ${done.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(done.length / 2)]} ms`);

// What the model says it sees: use these words in the landmark descriptions (lib/seed/demo-store.ts).
console.log(`\nModel evidence per expected landmark (for rewriting descriptions)`);
for (const e of labels.filter((l) => done.some((r) => r.expected === l))) {
  const ev = [...new Set(done.filter((r) => r.expected === e && r.evidence).map((r) => `${r.got === e ? "✓" : `→${r.got}`} ${r.evidence.slice(0, 160)}`))].slice(0, 5);
  console.log(`  ${e}:`);
  for (const line of ev) console.log(`    ${line}`);
}

if (OUT) {
  writeFileSync(OUT, JSON.stringify({ dir: DIR, store: STORE, group: GROUP, previous_node_id: PREV, results }, null, 2));
  console.log(`\nWrote ${OUT} (text only, no images).`);
}
