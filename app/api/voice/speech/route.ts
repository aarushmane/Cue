import { z } from "zod";
import { elevenlabs, voiceError, voiceGuard } from "@/lib/voice/elevenlabs";

export const maxDuration = 60;
const Body = z.object({
  text: z.string().trim().min(1).max(2000),
  voice_id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(),
  speed: z.number().min(0.7).max(1.2).default(1),
});

export async function POST(request: Request) {
  const blocked = voiceGuard(request);
  if (blocked) return blocked;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Send between 1 and 2,000 characters of text." }, { status: 400 });
  // George is a standard ElevenLabs voice; deployments can select another with this server-only variable.
  const voice = parsed.data.voice_id || process.env.ELEVENLABS_VOICE_ID?.trim() || "JBFqnCBsd6RMkjVDRZzb";
  try {
    const upstream = await elevenlabs(`text-to-speech/${encodeURIComponent(voice)}/stream?output_format=pcm_24000`, request.signal, {
      text: parsed.data.text, model_id: process.env.ELEVENLABS_TTS_MODEL?.trim() || "eleven_flash_v2_5",
      voice_settings: { speed: parsed.data.speed },
    });
    if (!upstream.ok || !upstream.body) return voiceError(upstream.status);
    return new Response(upstream.body, { headers: { "content-type": "application/octet-stream", "cache-control": "no-store", "x-audio-sample-rate": "24000" } });
  } catch { return voiceError(); }
}
