import { elevenlabs, voiceError, voiceGuard } from "@/lib/voice/elevenlabs";

export async function POST(request: Request) {
  const blocked = voiceGuard(request);
  if (blocked) return blocked;
  try {
    const upstream = await elevenlabs("single-use-token/realtime_scribe", request.signal);
    if (!upstream.ok) return voiceError(upstream.status);
    const data = await upstream.json() as { token?: string };
    if (!data.token) return voiceError();
    return Response.json({ token: data.token }, { headers: { "cache-control": "no-store" } });
  } catch { return voiceError(); }
}
