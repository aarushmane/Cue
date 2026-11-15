// Save a scan's product catalogue into the repo so searches for it need no AI calls.
//
//   npm run wayfinding:catalog -- <modelId> [--url http://localhost:3000]
//
// Asks the running app for the catalogue (it reads each photo face once, ~12 vision calls, if it hasn't yet) and
// writes data/wayfinding/<modelId>.catalog.json, which the app then uses as is.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const modelId = args.find((a) => !a.startsWith("--"));
const url = args.includes("--url") ? args[args.indexOf("--url") + 1] : "http://localhost:3000";
if (!modelId || !/^[a-zA-Z0-9]{11}$/.test(modelId)) {
  console.error("Usage: npm run wayfinding:catalog -- <modelId> [--url http://localhost:3000]");
  process.exit(1);
}
const response = await fetch(`${url}/api/wayfinding/catalog?model_id=${modelId}`, { signal: AbortSignal.timeout(300_000) });
const data = await response.json().catch(() => ({}));
if (!response.ok || !Array.isArray(data.items)) {
  console.error(`Could not get the catalogue (${response.status}): ${data.error ?? "unknown error"}`);
  process.exit(1);
}
const file = path.join("data", "wayfinding", `${modelId}.catalog.json`);
await mkdir(path.dirname(file), { recursive: true });
await writeFile(file, JSON.stringify({ at: data.at, items: data.items }, null, 1) + "\n");
const brands = [...new Set(data.items.map((i) => i.name))].sort();
console.log(`Saved ${data.items.length} placed products (${brands.length} brands) to ${file}:\n${brands.join(", ")}`);
