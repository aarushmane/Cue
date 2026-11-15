"use client";

import { useEffect, useRef, useState } from "react";
import { findWake } from "@/lib/voice/preferences";

// Minimal Web Speech API types (not in TypeScript's DOM lib).
type RecognitionResult = { isFinal: boolean; 0: { transcript: string } };
type RecognitionEvent = { resultIndex: number; results: ArrayLike<RecognitionResult> };
type Recognition = {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void; abort: () => void;
};
type RecognitionCtor = new () => Recognition;

function recognizer(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Hands-free start: while `enabled`, the browser's own speech recognition listens for "Hey Cue" and calls `onWake`
 * with whatever was said after it ("" when the visitor paused after the wake phrase). Only the finished phrase
 * counts, so the request isn't cut off mid-sentence. Restarts itself when the browser ends recognition (it does after
 * silence), backing off when it keeps failing. Returns whether it is listening.
 */
export function useWakeWord(enabled: boolean, onWake: (command: string) => void) {
  const latest = useRef(onWake);
  useEffect(() => { latest.current = onWake; }, [onWake]);
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    const Ctor = recognizer();
    if (!enabled || !Ctor) return;
    let alive = true, blocked = false, delay = 300, startedAt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let current: Recognition | null = null;
    const begin = () => {
      if (!alive || document.hidden) return;
      const rec = new Ctor();
      current = rec;
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-US";
      rec.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const result = event.results[i];
          if (!result.isFinal) continue;
          const command = findWake(result[0].transcript);
          if (command === null) continue;
          alive = false;
          rec.abort();
          setArmed(false);
          latest.current(command);
          return;
        }
      };
      rec.onerror = ({ error }) => { if (error === "not-allowed" || error === "service-not-allowed" || error === "audio-capture") blocked = true; };
      rec.onend = () => {
        if (current !== rec) return;
        current = null;
        if (!alive || blocked) { setArmed(false); return; }
        // Ended right away (offline, busy microphone): wait longer before trying again.
        delay = Date.now() - startedAt < 2000 ? Math.min(delay * 2, 15_000) : 300;
        timer = setTimeout(begin, delay);
      };
      startedAt = Date.now();
      try { rec.start(); setArmed(true); } catch { current = null; timer = setTimeout(begin, (delay = Math.min(delay * 2, 15_000))); }
    };
    const visibility = () => { if (!document.hidden && !current) { clearTimeout(timer); begin(); } };
    document.addEventListener("visibilitychange", visibility);
    begin();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visibility);
      const rec = current;
      current = null;
      rec?.abort();
      setArmed(false);
    };
  }, [enabled]);

  return armed;
}
