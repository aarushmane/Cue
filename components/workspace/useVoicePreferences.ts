"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { DEFAULT_VOICE_PREFERENCES, VoicePreferencesSchema, type VoicePreferences } from "@/lib/voice/preferences";

const KEY = "storeguide.voice.v1";
let memory = "";
function snapshot() { try { return localStorage.getItem(KEY) ?? memory; } catch { return memory; } }
function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener("voice-preferences", callback);
  return () => { window.removeEventListener("storage", callback); window.removeEventListener("voice-preferences", callback); };
}

export function useVoicePreferences() {
  const raw = useSyncExternalStore(subscribe, snapshot, () => "");
  const preferences = useMemo(() => {
    try { return VoicePreferencesSchema.parse(JSON.parse(raw)); } catch { return DEFAULT_VOICE_PREFERENCES; }
  }, [raw]);
  const update = useCallback((next: VoicePreferences) => {
    const parsed = VoicePreferencesSchema.safeParse(next);
    if (!parsed.success) return;
    memory = JSON.stringify(parsed.data);
    try { localStorage.setItem(KEY, memory); } catch {}
    window.dispatchEvent(new Event("voice-preferences"));
  }, []);
  return { preferences, update };
}
