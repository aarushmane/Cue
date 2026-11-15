// Resolve an image reference into a data URL the vision providers accept. Server-only.
// Remote fetches are limited to Matterport's CDN (signed panorama / floor-plan links) to avoid SSRF.

const ALLOWED_HOST = /(^|\.)matterport\.com$/i;
const MAX_BYTES = 8 * 1024 * 1024;

export async function resolveImage(src: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  if (!/^https:\/\//i.test(src)) return src; // data URL or raw base64
  const url = new URL(src);
  if (!ALLOWED_HOST.test(url.hostname)) throw new Error(`Image host not allowed: ${url.hostname}`);
  const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Image fetch failed: HTTP ${res.status} (signed links expire after about an hour; re-fetch the twin)`);
  const type = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
  if (!/^image\/(jpeg|png|webp)$/.test(type)) throw new Error(`Unsupported image type: ${type}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("Image too large");
  return `data:${type};base64,${buf.toString("base64")}`;
}
