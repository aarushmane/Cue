import "server-only";
import { clientKey, createLimiter } from "@/lib/api/rateLimit";

const limiter = createLimiter(40, 60_000);

export function voiceGuard(request: Request): Response | null {
  // Same-origin UI only. API keys never enter a browser bundle.
  const origin = request.headers.get("origin");
  if ((origin && origin !== new URL(request.url).origin) || request.headers.get("sec-fetch-site") === "cross-site") {
    return Response.json({ error: "Use voice from this application's page." }, { status: 403 });
  }
  const limit = limiter.hit(clientKey(request));
  if (!limit.ok) return Response.json({ error: "Too many voice requests. Try again shortly." }, {
    status: 429, headers: { "retry-after": String(limit.retryAfter) },
  });
  if (!process.env.ELEVENLABS_API_KEY?.trim()) return Response.json({ error: "Set ELEVENLABS_API_KEY on the server to enable voice." }, { status: 503 });
  return null;
}

export async function elevenlabs(path: string, signal: AbortSignal, body?: unknown) {
  return fetch(`https://api.elevenlabs.io/v1/${path}`, {
    method: "POST", headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]), cache: "no-store",
  });
}

export function voiceError(status = 502) {
  const error = status === 401 || status === 403 ? "ElevenLabs rejected the API key or its permissions. Check the server's ElevenLabs settings."
    : status === 429 ? "ElevenLabs voice quota or rate limit reached. Try again later."
    : "The voice service is unavailable. Try again.";
  // Do not forward provider bodies, which may include internal account details.
  return Response.json({ error }, { status: status === 429 ? 429 : 502 });
}
