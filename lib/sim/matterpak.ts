// A model's textured mesh from its MatterPak (official Model API bundle "mp:matterpak"), for the walkable simulation.
// Server only.
//
// The MatterPak is a ~75 MB zip (mostly the point cloud). Only the OBJ, its MTL and the texture JPGs are read, with
// HTTP range requests, then the OBJ is turned into a compact indexed binary the browser can load directly:
//
//   [u32 header length][header JSON][pad to 4][positions f32×3n][uvs f32×2n][indices u32×m]
//   header = { vertices: n, indices: m, groups: [{ texture, start, count }] }   (start/count in indices)
//
// Everything is cached under the OS temp folder, so each model is downloaded once per machine. Positions stay in the
// Model API frame (metres, z up), the same frame as the scan points and wayfinding.
//
// If Mann's pipeline (jb_store/) has baked photo textures for the model (`py bake_textures.py`, listed as "baked" in
// jb_store/data/<sid>/meta.json), that mesh is served instead, exactly as his viewer prefers it.
import "server-only";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { graph } from "../costar/matterport";

export type SimSource = "baked" | "matterpak";
export type SimMeta = { modelId: string; source: SimSource; textures: string[]; vertices: number; indices: number; bytes: number; version?: string };

const MODEL_ID = /^[a-zA-Z0-9]{11}$/;
const cacheDir = (modelId: string, source: SimSource) => path.join(tmpdir(), "storeguide-sim", modelId, source);
const jbData = (modelId: string) => path.join(process.cwd(), "jb_store", "data", modelId);

/** Mann's photo-baked mesh for this model, if his pipeline has produced one on this machine. */
async function localBake(modelId: string): Promise<{ obj: string; mtl: string | null; version: string } | null> {
  try {
    const meta = JSON.parse(await readFile(path.join(jbData(modelId), "meta.json"), "utf8")) as { baked?: { obj?: string; mtl?: string } };
    if (!meta.baked?.obj) return null;
    const obj = path.join(jbData(modelId), meta.baked.obj);
    if (!obj.startsWith(jbData(modelId))) return null;
    const mtl = meta.baked.mtl ? path.join(jbData(modelId), meta.baked.mtl) : null;
    const { mtimeMs, size } = await stat(obj);
    return { obj, mtl: mtl && mtl.startsWith(jbData(modelId)) ? mtl : null, version: `${mtimeMs}:${size}` };
  } catch {
    return null;
  }
}

async function matterpakUrl(modelId: string): Promise<string> {
  const d = await graph<{ model: { bundle?: { availability?: string; assets?: { url?: string | null }[] } | null } | null }>(
    `query MatterPak($id: ID!) { model(id: $id) { bundle(id: "mp:matterpak") { availability assets { ... on Resource { url } } } } }`,
    { id: modelId },
  );
  const url = d.model?.bundle?.assets?.find((a) => a.url)?.url;
  if (!url) throw new Error(`This scan's MatterPak is ${d.model?.bundle?.availability ?? "unavailable"}.`);
  if (!new URL(url).hostname.endsWith(".matterport.com")) throw new Error("Unexpected MatterPak host.");
  return url;
}

// ── Zip over HTTP range requests ──
type Entry = { name: string; method: number; compressed: number; size: number; offset: number };

async function range(url: string, start: number, end: number): Promise<Buffer> {
  const r = await fetch(url, { headers: { range: `bytes=${start}-${end}` }, signal: AbortSignal.timeout(120_000) });
  if (r.status !== 206 && r.status !== 200) throw new Error(`MatterPak download failed (${r.status}).`);
  const b = Buffer.from(await r.arrayBuffer());
  return r.status === 200 ? b.subarray(start, end + 1) : b;
}

async function listZip(url: string): Promise<Entry[]> {
  const head = await fetch(url, { headers: { range: "bytes=0-0" }, signal: AbortSignal.timeout(30_000) });
  const total = Number(head.headers.get("content-range")?.split("/")[1]);
  await head.body?.cancel();
  if (!total) throw new Error("MatterPak size unknown.");
  const tail = await range(url, Math.max(0, total - 65_557), total - 1);
  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error("MatterPak is not a zip.");
  const cdSize = tail.readUInt32LE(eocd + 12), cdOffset = tail.readUInt32LE(eocd + 16);
  const cd = await range(url, cdOffset, cdOffset + cdSize - 1);
  const entries: Entry[] = [];
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
    const nameLen = cd.readUInt16LE(p + 28), extraLen = cd.readUInt16LE(p + 30), commentLen = cd.readUInt16LE(p + 32);
    entries.push({
      method: cd.readUInt16LE(p + 10), compressed: cd.readUInt32LE(p + 20), size: cd.readUInt32LE(p + 24),
      offset: cd.readUInt32LE(p + 42), name: cd.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function readEntry(url: string, e: Entry): Promise<Buffer> {
  const local = await range(url, e.offset, e.offset + 29);
  const start = e.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = e.compressed ? await range(url, start, start + e.compressed - 1) : Buffer.alloc(0);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRawSync(data);
  throw new Error(`Unsupported zip compression ${e.method}.`);
}

// ── OBJ + MTL → indexed binary ──
/** Pure: OBJ text (+ material → texture file) → packed mesh. Exported for tests. */
export function packObj(obj: string, textureOf: Map<string, string>): { header: { vertices: number; indices: number; groups: { texture: string | null; start: number; count: number }[] }; positions: Float32Array; uvs: Float32Array; indices: Uint32Array } {
  const v: number[] = [], vt: number[] = [];
  const key = new Map<string, number>();
  const positions: number[] = [], uvs: number[] = [];
  const byMaterial = new Map<string, number[]>();
  let current = byMaterial.get("") ?? [];
  byMaterial.set("", current);
  const vertex = (token: string) => {
    let id = key.get(token);
    if (id !== undefined) return id;
    const [a, b] = token.split("/");
    const vi = Number(a) < 0 ? v.length / 3 + Number(a) : Number(a) - 1;
    const ti = b ? (Number(b) < 0 ? vt.length / 2 + Number(b) : Number(b) - 1) : -1;
    id = positions.length / 3;
    positions.push(v[vi * 3], v[vi * 3 + 1], v[vi * 3 + 2]);
    uvs.push(ti >= 0 ? vt[ti * 2] : 0, ti >= 0 ? vt[ti * 2 + 1] : 0);
    key.set(token, id);
    return id;
  };
  for (const raw of obj.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("v ")) { const s = line.split(/\s+/); v.push(Number(s[1]), Number(s[2]), Number(s[3])); }
    else if (line.startsWith("vt ")) { const s = line.split(/\s+/); vt.push(Number(s[1]), Number(s[2])); }
    else if (line.startsWith("usemtl")) {
      const name = line.slice(6).trim();
      current = byMaterial.get(name) ?? [];
      byMaterial.set(name, current);
    } else if (line.startsWith("f ")) {
      const ids = line.split(/\s+/).slice(1).map(vertex);
      for (let k = 1; k + 1 < ids.length; k++) current.push(ids[0], ids[k], ids[k + 1]);
    }
  }
  const groups: { texture: string | null; start: number; count: number }[] = [];
  const indices: number[] = [];
  for (const [name, tris] of byMaterial) {
    if (!tris.length) continue;
    groups.push({ texture: textureOf.get(name) ?? null, start: indices.length, count: tris.length });
    for (const i of tris) indices.push(i);
  }
  return {
    header: { vertices: positions.length / 3, indices: indices.length, groups },
    positions: Float32Array.from(positions), uvs: Float32Array.from(uvs), indices: Uint32Array.from(indices),
  };
}

function parseMtl(mtl: string): Map<string, string> {
  const out = new Map<string, string>();
  let current = "";
  for (const raw of mtl.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("newmtl")) current = line.slice(6).trim();
    else if (line.startsWith("map_Kd") && current) out.set(current, path.basename(line.slice(6).trim()));
  }
  return out;
}

const building = new Map<string, Promise<SimMeta>>();

async function writePacked(dir: string, objText: string, textureOf: Map<string, string>, base: Omit<SimMeta, "vertices" | "indices" | "bytes">): Promise<SimMeta> {
  const packed = packObj(objText, textureOf);
  const header = Buffer.from(JSON.stringify(packed.header));
  const pad = (4 - ((4 + header.length) % 4)) % 4;
  const bin = Buffer.concat([
    Buffer.from(new Uint32Array([header.length + pad]).buffer), header, Buffer.alloc(pad, 0x20),
    Buffer.from(packed.positions.buffer), Buffer.from(packed.uvs.buffer), Buffer.from(packed.indices.buffer),
  ]);
  await writeFile(path.join(dir, "mesh.bin"), bin);
  const meta: SimMeta = { ...base, vertices: packed.header.vertices, indices: packed.header.indices, bytes: bin.length };
  await writeFile(path.join(dir, "meta.json"), JSON.stringify(meta));
  return meta;
}

/**
 * Make sure a mesh for the model is cached locally and return what is there. `prefer: "auto"` takes Mann's baked mesh
 * when it exists, else the MatterPak; `"matterpak"` always the MatterPak (the viewer's T toggle).
 */
export function ensureSimAssets(modelId: string, prefer: "auto" | "matterpak" = "auto"): Promise<SimMeta> {
  if (!MODEL_ID.test(modelId)) return Promise.reject(new Error("Bad model id."));
  const jobKey = `${modelId}:${prefer}`;
  const running = building.get(jobKey);
  if (running) return running;
  const job = (async (): Promise<SimMeta> => {
    const bake = prefer === "auto" ? await localBake(modelId) : null;
    const source: SimSource = bake ? "baked" : "matterpak";
    const dir = cacheDir(modelId, source);
    try {
      const cached = JSON.parse(await readFile(path.join(dir, "meta.json"), "utf8")) as SimMeta;
      if (!bake || cached.version === bake.version) return cached;
    } catch {
      // not cached yet
    }
    await mkdir(path.join(dir, "textures"), { recursive: true });

    if (bake) {
      const objText = await readFile(bake.obj, "utf8");
      const textureOf = bake.mtl ? parseMtl(await readFile(bake.mtl, "utf8")) : new Map<string, string>();
      const from = bake.mtl ? path.dirname(bake.mtl) : path.dirname(bake.obj);
      const names = [...new Set(textureOf.values())];
      for (const name of names) await writeFile(path.join(dir, "textures", name), await readFile(path.join(from, name)));
      return writePacked(dir, objText, textureOf, { modelId, source, textures: names, version: bake.version });
    }

    const url = await matterpakUrl(modelId);
    const entries = await listZip(url);
    const objEntry = entries.filter((e) => e.name.toLowerCase().endsWith(".obj")).sort((a, b) => b.size - a.size)[0];
    if (!objEntry) throw new Error("No mesh in this MatterPak.");
    const mtlEntry = entries.find((e) => e.name.toLowerCase().endsWith(".mtl"));
    const [objText, mtlText] = await Promise.all([readEntry(url, objEntry).then((b) => b.toString("utf8")), mtlEntry ? readEntry(url, mtlEntry).then((b) => b.toString("utf8")) : ""]);
    const textureOf = parseMtl(mtlText);
    const wanted = new Set(textureOf.values());
    const textureEntries = entries.filter((e) => wanted.has(path.basename(e.name)));
    for (let i = 0; i < textureEntries.length; i += 6) {
      await Promise.all(textureEntries.slice(i, i + 6).map(async (e) => writeFile(path.join(dir, "textures", path.basename(e.name)), await readEntry(url, e))));
    }
    return writePacked(dir, objText, textureOf, { modelId, source, textures: textureEntries.map((e) => path.basename(e.name)) });
  })();
  building.set(jobKey, job);
  job.finally(() => building.delete(jobKey)).catch(() => {});
  return job;
}

/** Identifies the cached build, so browsers can revalidate instead of keeping an old mesh (e.g. before a new bake). */
export const simTag = (meta: SimMeta) => `"${meta.source}-${meta.version ?? "pak"}-${meta.bytes}"`;

export async function simMesh(modelId: string, prefer: "auto" | "matterpak" = "auto"): Promise<{ bin: Buffer; source: SimSource; tag: string }> {
  const meta = await ensureSimAssets(modelId, prefer);
  return { bin: await readFile(path.join(cacheDir(modelId, meta.source), "mesh.bin")), source: meta.source, tag: simTag(meta) };
}

export async function simTagFor(modelId: string, source: SimSource): Promise<string> {
  return simTag(await ensureSimAssets(modelId, source === "baked" ? "auto" : "matterpak"));
}

export async function simTexture(modelId: string, source: SimSource, name: string): Promise<Buffer | null> {
  const meta = await ensureSimAssets(modelId, source === "baked" ? "auto" : "matterpak");
  if (meta.source !== source || !meta.textures.includes(name)) return null;
  return readFile(path.join(cacheDir(modelId, source), "textures", name));
}
