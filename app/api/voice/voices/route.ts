import { STANDARD_VOICES } from "@/lib/voice/preferences";
import { voiceError, voiceGuard } from "@/lib/voice/elevenlabs";

export async function GET(request: Request) {
  const blocked = voiceGuard(request);
  if (blocked) return blocked;
  const defaultVoiceId = process.env.ELEVENLABS_VOICE_ID?.trim() || STANDARD_VOICES[0].id;
  try {
    const upstream = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY! }, cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      if (data.detail?.status === "missing_permissions") return Response.json({
        voices: STANDARD_VOICES, defaultVoiceId,
        warning: "Enable Voices: Read on your ElevenLabs key to load account voices. Standard voices are available below.",
      }, { headers: { "cache-control": "no-store" } });
      return voiceError(upstream.status);
    }
    const voices = (data.voices ?? []).filter((v: { voice_id?: unknown; name?: unknown }) => typeof v.voice_id === "string" && typeof v.name === "string")
      .slice(0, 500).map((v: { voice_id: string; name: string }) => ({ id: v.voice_id, name: v.name }));
    return Response.json({ voices, defaultVoiceId }, { headers: { "cache-control": "no-store" } });
  } catch { return voiceError(); }
}
