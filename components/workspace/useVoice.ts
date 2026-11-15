"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioFormat, CommitStrategy, RealtimeEvents, Scribe, type RealtimeConnection } from "@elevenlabs/client";
import { useMicrophone, type MicrophoneCapture } from "./useMicrophone";
import { isStopCommand, VoiceTurn, type VoiceMessage, type VoiceResult } from "@/lib/voice/types";
import { playSpeech } from "@/lib/voice/playback";
import { wakeCommand, type VoicePreferences } from "@/lib/voice/preferences";
import type { GuidanceCue } from "@/lib/voice/guidance";

export type VoiceBridge = {
  context: () => Record<string, unknown>;
  apply: (result: VoiceResult) => void;
  stop: () => void;
  moving: () => boolean;
  guidance: () => GuidanceCue | null;
};
type Session = { abort: AbortController; capture?: MicrophoneCapture; connection?: RealtimeConnection; input?: AudioWorkletNode; timeout?: ReturnType<typeof setTimeout>; connected: boolean };
type Phase = "off" | "connecting" | "listening" | "thinking" | "speaking";

export function useVoice(bridge: VoiceBridge, preferences: VoicePreferences) {
  const microphone = useMicrophone();
  const { start: startMicrophone, stop: stopMicrophone } = microphone;
  const latest = useRef(bridge);
  useEffect(() => { latest.current = bridge; }, [bridge]);
  const options = useRef(preferences);
  useEffect(() => { options.current = preferences; }, [preferences]);
  const wakeUntil = useRef(0);
  const wasMoving = useRef(false);
  const guidanceSpoken = useRef({ key: "", at: 0 });
  const session = useRef<Session | null>(null);
  const turn = useRef(new VoiceTurn());
  const busy = useRef(false);
  const history = useRef<VoiceMessage[]>([]);
  const [phase, setPhase] = useState<Phase>("off");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [output, setOutput] = useState<AnalyserNode | null>(null);

  const interrupt = useCallback(() => {
    turn.current.cancel();
    busy.current = false;
    wasMoving.current = false;
    latest.current.stop();
    setOutput(null);
    setPhase(session.current?.connected ? "listening" : session.current ? "connecting" : "off");
  }, []);

  const dispose = useCallback(() => {
    turn.current.cancel();
    busy.current = false;
    latest.current.stop();
    const old = session.current;
    session.current = null;
    wakeUntil.current = 0;
    wasMoving.current = false;
    old?.abort.abort();
    clearTimeout(old?.timeout);
    old?.connection?.close();
    if (old?.input) { old.input.port.onmessage = null; old.input.disconnect(); }
  }, []);
  const stop = useCallback(() => {
    dispose(); stopMicrophone(); setPhase("off"); setOutput(null); setTranscript("");
  }, [dispose, stopMicrophone]);

  const say = useCallback(async (text: string, signal: AbortSignal, current: Session) => {
    if (!current.capture || !options.current.spokenResponses) return;
    guidanceSpoken.current.at = Date.now();
    setPhase("speaking");
    await playSpeech(text, current.capture.context, signal, (analyser) => {
      if (!signal.aborted && session.current === current) setOutput(analyser);
    }, options.current);
  }, []);

  const accept = useCallback((text: string) => {
    const wake = wakeCommand(text);
    if (isStopCommand(wake.command)) return wake.command;
    if (wake.wake) wakeUntil.current = Date.now() + 8000;
    if (!options.current.wakeWord || wake.wake || Date.now() < wakeUntil.current) return wake.command;
    return null;
  }, []);

  const submit = useCallback(async (raw: string) => {
    const current = session.current;
    const text = accept(raw);
    if (!current?.connected || text === null) return;
    if (!text) { interrupt(); return; }
    wakeUntil.current = 0;
    interrupt();
    setTranscript(text);
    setError(null);
    const signal = turn.current.begin();
    busy.current = true;
    try {
      if (isStopCommand(text)) {
        // No model latency on stop. The local VAD has already stopped motion/speech.
        setReply("Stopped.");
        await say("Stopped.", signal, current);
        return;
      }
      setPhase("thinking");
      const response = await fetch("/api/voice/turn", {
        method: "POST", headers: { "content-type": "application/json" }, signal,
        body: JSON.stringify({ ...latest.current.context(), query: text.slice(0, 300), history: history.current.slice(-8) }),
      });
      const result = await response.json() as VoiceResult & { error?: string };
      if (!response.ok) throw new Error(result.error || "Could not complete the voice request.");
      signal.throwIfAborted();
      if (session.current !== current) return;
      latest.current.apply(result);
      setReply(result.reply);
      history.current = [...history.current, { role: "user", content: text.slice(0, 300) }, { role: "assistant", content: result.reply }].slice(-8) as VoiceMessage[];
      await say(result.reply, signal, current);
    } catch (error) {
      if (!signal.aborted && session.current === current) {
        latest.current.stop();
        setError(error instanceof Error ? error.message : "Voice request failed. Try again.");
      }
    } finally {
      if (!signal.aborted && session.current === current) { busy.current = false; setPhase("listening"); setOutput(null); }
    }
  }, [interrupt, say, accept]);

  const start = useCallback(async () => {
    stop();
    setError(null);
    setPhase("connecting");
    const current: Session = { abort: new AbortController(), connected: false };
    session.current = current;
    try {
      const capture = await startMicrophone();
      if (session.current !== current) return;
      if (!capture) { dispose(); setPhase("off"); return; }
      current.capture = capture;
      const response = await fetch("/api/voice/token", { method: "POST", signal: current.abort.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not connect voice.");
      current.abort.signal.throwIfAborted();
      await capture.context.audioWorklet.addModule("/audio/voice-input.js");
      current.abort.signal.throwIfAborted();
      const connection = Scribe.connect({ token: data.token, modelId: "scribe_v2_realtime", audioFormat: AudioFormat.PCM_16000,
        sampleRate: 16000, commitStrategy: CommitStrategy.VAD, vadSilenceThresholdSecs: 0.6 });
      current.connection = connection;
      const fail = (message: string) => {
        if (session.current !== current) return;
        stop(); setError(message);
      };
      current.timeout = setTimeout(() => fail("Voice connection timed out. Enable the microphone to try again."), 15_000);
      connection.on(RealtimeEvents.SESSION_STARTED, () => {
        if (session.current !== current) { connection.close(); return; }
        current.connected = true;
        clearTimeout(current.timeout);
        const input = new AudioWorkletNode(capture.context, "voice-input");
        current.input = input;
        let loud = 0;
        let latched = false;
        input.port.onmessage = ({ data }: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
          if (session.current !== current) return;
          // Require ~200 ms above the gate. Partial transcripts also interrupt, catching quieter speakers.
          loud = data.rms > 0.025 ? loud + 1 : 0;
          if (!loud) latched = false;
          if (loud >= 2 && !latched) {
            latched = true;
            if (!options.current.wakeWord && (busy.current || latest.current.moving())) interrupt();
          }
          try {
            const bytes = new Uint8Array(data.pcm);
            connection.send({ audioBase64: btoa(String.fromCharCode(...bytes)), sampleRate: 16000 });
          } catch { fail("Voice connection lost. Enable the microphone to reconnect."); }
        };
        capture.source.connect(input);
        input.connect(capture.context.destination); // Worklet emits silence, never the microphone signal.
        setPhase("listening");
      });
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, ({ text }) => {
        if (session.current !== current || !text.trim()) return;
        const command = accept(text);
        if (command === null) return;
        if (busy.current || latest.current.moving()) interrupt();
        setTranscript(command);
      });
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text }) => { if (session.current === current) void submit(text); });
      connection.on(RealtimeEvents.ERROR, () => fail("ElevenLabs transcription failed. Check your key, speech-to-text permissions and quota, then reconnect."));
      connection.on(RealtimeEvents.CLOSE, () => fail("Voice disconnected. Enable the microphone to reconnect."));
    } catch (error) {
      if (session.current !== current) return;
      stop(); setError(error instanceof Error ? error.message : "Could not start voice.");
    }
  }, [stop, dispose, startMicrophone, interrupt, submit, accept]);

  const replay = useCallback(async () => {
    const current = session.current;
    if (!current?.connected || !reply || !options.current.spokenResponses) return;
    interrupt();
    const signal = turn.current.begin();
    busy.current = true;
    try { await say(reply, signal, current); }
    catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : "Could not replay speech."); }
    finally { if (!signal.aborted && session.current === current) { busy.current = false; setPhase("listening"); setOutput(null); } }
  }, [reply, interrupt, say]);

  useEffect(() => {
    const timer = setInterval(async () => {
      const current = session.current;
      if (!current?.connected || busy.current || !options.current.guidance || !options.current.spokenResponses) return;
      const moving = latest.current.moving();
      const justStopped = wasMoving.current && !moving;
      wasMoving.current = moving;
      if (!moving && !justStopped) return;
      const cue = latest.current.guidance();
      if (!cue || (!moving && !cue.arrived) || cue.key === guidanceSpoken.current.key) return;
      if (!cue.arrived && Date.now() - guidanceSpoken.current.at < 8000) return;
      const signal = turn.current.begin();
      guidanceSpoken.current = { key: cue.key, at: Date.now() };
      busy.current = true;
      setReply(cue.text);
      try { await say(cue.text, signal, current); }
      catch (error) { if (!signal.aborted && session.current === current) setError(error instanceof Error ? error.message : "Could not speak directions."); }
      finally { if (!signal.aborted && session.current === current) { busy.current = false; setOutput(null); setPhase("listening"); } }
    }, 1000);
    return () => clearInterval(timer);
  }, [say]);

  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    const escape = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.isContentEditable || target?.closest("input, textarea, select");
      if (event.key === "Escape" || (!typing && ["KeyW", "KeyA", "KeyS", "KeyD", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.code))) interrupt();
    };
    const takeOver = (event: PointerEvent) => {
      if ((event.target as HTMLElement | null)?.closest(".scene canvas")) interrupt();
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", stop);
    // Capture runs before the viewer's key handler so its new manual movement is not cleared.
    window.addEventListener("keydown", escape, true);
    window.addEventListener("pointerdown", takeOver, true);
    return () => {
      dispose();
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", stop);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("pointerdown", takeOver, true);
    };
  }, [stop, dispose, interrupt]);
  // Hardware disconnection also closes the websocket and cancels agent/audio work.
  useEffect(() => { if (microphone.state.status === "off" && session.current?.capture) stop(); }, [microphone.state.status, stop]);

  return { phase, error: error ?? microphone.state.error, analyser: output ?? microphone.state.analyser, transcript, reply, start, stop, interrupt, replay };
}
