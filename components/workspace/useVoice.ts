"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioFormat, CommitStrategy, RealtimeEvents, Scribe, type RealtimeConnection } from "@elevenlabs/client";
import { useMicrophone, type MicrophoneCapture } from "./useMicrophone";
import { isStopCommand, VoiceTurn, type VoiceEvent, type VoiceMessage, type VoiceResult } from "@/lib/voice/types";
import { playSpeech } from "@/lib/voice/playback";
import { wakeCommand, type VoicePreferences } from "@/lib/voice/preferences";
import type { GuidanceCue } from "@/lib/voice/guidance";
import { voiceSocket } from "@/lib/voice/socket";
import { normalize } from "@/lib/search/matchProducts";
import type { VoiceClarification } from "@/lib/voice/clarification";

export type VoiceBridge = {
  context: () => Record<string, unknown>;
  apply: (result: VoiceResult) => void;
  stop: () => void;
  moving: () => boolean;
  guidance: () => GuidanceCue | null;
};
/**
 * One tap of the microphone is one session: the microphone transcribes a single request (closing once the visitor
 * stops speaking), then the session stays alive only for the reply, any clarifying question, and spoken directions.
 */
type Session = {
  abort: AbortController; capture?: MicrophoneCapture; connection?: RealtimeConnection; input?: AudioWorkletNode;
  timeout?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>; connected: boolean;
};
export type VoicePhase = "off" | "connecting" | "listening" | "thinking" | "speaking" | "idle";

/** Silence before the first word, and after the last, that ends listening. */
const NO_SPEECH_MS = 8000;
const TRAILING_SILENCE_MS = 4000;
/** Grace after a VAD commit, so a natural pause mid-sentence doesn't cut the request short. */
const COMMIT_GRACE_MS = 700;

function joinSpeech(previous: string, next: string) {
  const a = previous.trim().split(/\s+/).filter(Boolean), b = next.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(a.length, b.length); n > 0; n--) {
    if (a.slice(-n).join(" ").toLowerCase() === b.slice(0, n).join(" ").toLowerCase()) return [...a, ...b.slice(n)].join(" ");
  }
  return [...a, ...b].join(" ");
}

/** Unfinished openings ("can you find me the …") wait for more speech rather than being sent. */
function incomplete(text: string) {
  return !normalize(text) || /[-–—…]\s*$/.test(text) || /\b(?:to|for|and|the|a|an|some|me)[\p{P}\s]*$/iu.test(text);
}

export function useVoice(bridge: VoiceBridge, preferences: VoicePreferences) {
  const microphone = useMicrophone();
  const { start: startMicrophone, stop: stopMicrophone } = microphone;
  const latest = useRef(bridge);
  useEffect(() => { latest.current = bridge; }, [bridge]);
  const options = useRef(preferences);
  useEffect(() => { options.current = preferences; }, [preferences]);
  const clarification = useRef<VoiceClarification | null>(null);
  const utterance = useRef({ text: "", timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const lastSpeech = useRef({ text: "", at: 0, playing: false });
  const wasMoving = useRef(false);
  const guidanceSpoken = useRef({ key: "", at: 0 });
  const session = useRef<Session | null>(null);
  const turn = useRef(new VoiceTurn());
  const busy = useRef(false);
  const history = useRef<VoiceMessage[]>([]);
  const listenRef = useRef<(current: Session) => Promise<void>>(async () => {});
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [output, setOutput] = useState<AnalyserNode | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [progress, setProgress] = useState<Extract<VoiceEvent, { type: "progress" }> | null>(null);
  const [navigation, setNavigation] = useState<"idle" | "guiding" | "arrived">("idle");

  const resetUtterance = useCallback(() => {
    clearTimeout(utterance.current.timer);
    utterance.current.text = "";
  }, []);

  /** Close transcription but keep the session (and its audio output) for the reply and directions. */
  const stopListening = useCallback((current: Session) => {
    clearTimeout(current.timeout);
    clearTimeout(current.idle);
    const { connection, input } = current;
    current.connection = undefined;
    current.input = undefined;
    if (input) { input.port.onmessage = null; input.disconnect(); }
    connection?.close();
  }, []);

  const cancelWork = useCallback(() => {
    resetUtterance();
    turn.current.cancel();
    busy.current = false;
    wasMoving.current = false;
    latest.current.stop();
    setOutput(null);
    setInterrupted(true);
    setProgress(null);
    setNavigation("idle");
    const current = session.current;
    setPhase(!current ? "off" : current.connection ? current.connected ? "listening" : "connecting" : "idle");
  }, [resetUtterance]);

  const dispose = useCallback(() => {
    turn.current.cancel();
    busy.current = false;
    latest.current.stop();
    const old = session.current;
    session.current = null;
    clarification.current = null;
    resetUtterance();
    history.current = [];
    lastSpeech.current = { text: "", at: 0, playing: false };
    wasMoving.current = false;
    old?.abort.abort();
    if (old) stopListening(old);
  }, [resetUtterance, stopListening]);

  /** End the session. The last request and reply stay on screen. */
  const stop = useCallback(() => {
    dispose(); stopMicrophone(); setPhase("off"); setOutput(null); setInterrupted(false); setProgress(null); setNavigation("idle");
  }, [dispose, stopMicrophone]);

  /** Stop speech and movement. With nothing left to do, the session then ends on its own. */
  const interrupt = useCallback(() => {
    clarification.current = null;
    if (session.current) stopListening(session.current);
    cancelWork();
  }, [cancelWork, stopListening]);

  const say = useCallback(async (text: string, signal: AbortSignal, current: Session) => {
    if (!current.capture || !options.current.spokenResponses) return;
    guidanceSpoken.current.at = Date.now();
    setInterrupted(false);
    setPhase("speaking");
    const spoken = { text, at: Date.now(), playing: true };
    lastSpeech.current = spoken;
    try { await playSpeech(text, current.capture.context, signal, (analyser) => {
      if (!signal.aborted && session.current === current) setOutput(analyser);
    }, options.current); }
    finally { spoken.playing = false; spoken.at = Date.now(); }
  }, []);

  /** The tail of our own reply picked up by the microphone when listening reopens for a clarifying answer. */
  const echo = useCallback((text: string) => {
    const spoken = lastSpeech.current;
    if (!spoken.playing && Date.now() - spoken.at > 1000) return false;
    const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const input = words(text), output = words(spoken.text);
    return input.length > 0 && input.filter((word) => output.includes(word)).length / input.length >= 0.8;
  }, []);

  const submit = useCallback(async (raw: string) => {
    const current = session.current;
    if (!current?.connected) return;
    stopListening(current);
    resetUtterance();
    // "Hey Cue" is no longer needed, but a habitual one shouldn't reach the agent.
    const text = wakeCommand(raw).command;
    const answering = clarification.current;
    clarification.current = null;
    if (!text) { setPhase("idle"); return; }
    cancelWork();
    setInterrupted(false);
    setTranscript(text);
    setError(null);
    const signal = turn.current.begin();
    busy.current = true;
    let reopen = false;
    try {
      if (isStopCommand(text)) {
        setReply("Stopped.");
        await say("Stopped.", signal, current);
        if (!signal.aborted) setInterrupted(true);
        return;
      }
      setPhase("thinking");
      setProgress({ type: "progress", stage: "loading", label: "Loading scene" });
      const result = await voiceSocket.request<VoiceResult>("turn", {
        ...latest.current.context(), query: text.slice(0, 300), history: history.current.slice(-8), ...(answering ? { clarification: answering } : {}),
      }, signal, (event) => {
        if (signal.aborted || session.current !== current) return;
        if (event.type === "progress") setProgress(event);
        else if (event.type === "route") {
          latest.current.apply({ reply: "", actions: [], item: event.item, plan: event.plan });
          setProgress({ type: "progress", stage: "routing", label: event.plan.status === "OK" || event.plan.status === "ALREADY_THERE" ? "Path ready" : "Route unavailable" });
        } else latest.current.apply({ reply: "", actions: [event.action], item: null, plan: null });
      });
      signal.throwIfAborted();
      if (session.current !== current) return;
      const movement = result.actions.filter((action) => action.type === "move");
      latest.current.apply({ ...result, actions: result.actions.filter((action) => action.type !== "move") });
      setProgress(null);
      setReply(result.reply);
      history.current = [...history.current, { role: "user", content: text.slice(0, 300) }, { role: "assistant", content: result.reply }].slice(-8) as VoiceMessage[];
      await say(result.reply, signal, current);
      signal.throwIfAborted();
      if (result.clarification) {
        // A question gets one more listening turn, without another tap.
        clarification.current = result.clarification;
        reopen = true;
      }
      if (movement.length) {
        guidanceSpoken.current.key = "";
        if (result.plan?.status === "ALREADY_THERE") {
          latest.current.apply({ ...result, actions: [{ type: "face", target: "destination" }] });
          setNavigation("arrived");
        } else {
          latest.current.apply({ ...result, actions: movement });
          wasMoving.current = true;
          setNavigation("guiding");
        }
      }
    } catch (error) {
      if (!signal.aborted && session.current === current) {
        latest.current.stop(); setInterrupted(true);
        setError(error instanceof Error ? error.message : "Voice request failed. Try again.");
      }
    } finally {
      if (!signal.aborted && session.current === current) {
        busy.current = false; setOutput(null); setProgress(null); setPhase("idle");
        if (reopen) void listenRef.current(current);
      }
    }
  }, [cancelWork, resetUtterance, say, stopListening]);

  /** Open one transcription turn on the session's microphone. */
  const listen = useCallback(async (current: Session) => {
    const capture = current.capture;
    if (!capture || session.current !== current) return;
    stopListening(current);
    setPhase("connecting");
    try {
      const data = await voiceSocket.request<{ token: string }>("token", {}, current.abort.signal);
      current.abort.signal.throwIfAborted();
      if (session.current !== current) return;
      const connection = Scribe.connect({ token: data.token, modelId: "scribe_v2_realtime", audioFormat: AudioFormat.PCM_16000,
        sampleRate: 16000, commitStrategy: CommitStrategy.VAD, vadSilenceThresholdSecs: 0.7,
        filterBackgroundAudio: true, keyterms: ["Hey Cue", "Cue"] });
      current.connection = connection;
      const live = () => session.current === current && current.connection === connection;
      const fail = (message: string) => { if (live()) { stop(); setError(message); } };
      // Ends listening when the visitor never starts, or trails off without a clear end of sentence.
      const armIdle = (ms: number) => {
        clearTimeout(current.idle);
        current.idle = setTimeout(() => {
          if (!live()) return;
          const pending = utterance.current.text;
          if (normalize(pending)) { void submit(pending); return; }
          clarification.current = null;
          stopListening(current);
          setPhase("idle");
        }, ms);
      };
      current.timeout = setTimeout(() => fail("Voice connection timed out. Tap the microphone to try again."), 15_000);
      connection.on(RealtimeEvents.SESSION_STARTED, () => {
        if (!live()) { connection.close(); return; }
        current.connected = true;
        clearTimeout(current.timeout);
        const input = new AudioWorkletNode(capture.context, "voice-input");
        current.input = input;
        input.port.onmessage = ({ data }: MessageEvent<{ pcm: ArrayBuffer }>) => {
          if (!live()) return;
          try {
            const bytes = new Uint8Array(data.pcm);
            connection.send({ audioBase64: btoa(String.fromCharCode(...bytes)), sampleRate: 16000 });
          } catch { fail("Voice connection lost. Tap the microphone to try again."); }
        };
        capture.source.connect(input);
        input.connect(capture.context.destination); // Worklet emits silence, never the microphone signal.
        setPhase("listening");
        setInterrupted(false);
        armIdle(NO_SPEECH_MS);
      });
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, ({ text: raw }) => {
        if (!live() || !raw.trim() || echo(raw)) return;
        armIdle(TRAILING_SILENCE_MS);
        clearTimeout(utterance.current.timer); // Still talking: don't send the collected part yet.
        setTranscript(joinSpeech(utterance.current.text, wakeCommand(raw).command));
      });
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text: raw }) => {
        if (!live() || !raw.trim() || echo(raw)) return;
        const command = wakeCommand(raw).command;
        if (!command) return; // Only "Hey Cue": keep listening for the request.
        clearTimeout(utterance.current.timer);
        if (isStopCommand(command)) { void submit(command); return; }
        utterance.current.text = joinSpeech(utterance.current.text, command);
        setTranscript(utterance.current.text);
        armIdle(TRAILING_SILENCE_MS);
        // VAD can split a sentence at a pause; send once no further speech follows.
        utterance.current.timer = setTimeout(() => {
          const complete = utterance.current.text;
          if (live() && !incomplete(complete)) void submit(complete);
        }, COMMIT_GRACE_MS);
      });
      connection.on(RealtimeEvents.ERROR, () => fail("ElevenLabs transcription failed. Check your key, speech-to-text permissions and quota, then try again."));
      connection.on(RealtimeEvents.CLOSE, () => fail("Voice disconnected. Tap the microphone to try again."));
    } catch (error) {
      if (session.current !== current) return;
      stop(); setError(error instanceof Error ? error.message : "Could not start voice.");
    }
  }, [echo, stop, stopListening, submit]);
  useEffect(() => { listenRef.current = listen; }, [listen]);

  const start = useCallback(async () => {
    stop();
    setError(null);
    setTranscript("");
    setReply("");
    setPhase("connecting");
    const current: Session = { abort: new AbortController(), connected: false };
    session.current = current;
    try {
      const capture = await startMicrophone();
      if (session.current !== current) return;
      if (!capture) { dispose(); setPhase("off"); return; }
      current.capture = capture;
      await capture.context.audioWorklet.addModule("/audio/voice-input.js");
      current.abort.signal.throwIfAborted();
      await listen(current);
    } catch (error) {
      if (session.current !== current) return;
      stop(); setError(error instanceof Error ? error.message : "Could not start voice.");
    }
  }, [stop, dispose, startMicrophone, listen]);

  // Spoken directions while walking, and ending the session once nothing is left to do.
  useEffect(() => {
    const timer = setInterval(async () => {
      const current = session.current;
      if (!current?.connected || current.connection) return;
      if (busy.current || clarification.current || utterance.current.text) return;
      const moving = latest.current.moving();
      if (!options.current.guidance || !options.current.spokenResponses) {
        wasMoving.current = moving;
        if (!moving) stop();
        return;
      }
      const justStopped = wasMoving.current && !moving;
      wasMoving.current = moving;
      const cue = latest.current.guidance();
      if (cue?.arrived && moving) return; // Wait for the final facing motion before announcing arrival.
      if (cue?.arrived && !moving && justStopped && cue.key !== guidanceSpoken.current.key) {
        wasMoving.current = false;
        setNavigation("arrived");
      } else if (!moving && !justStopped) { stop(); return; }
      if (!cue || (!moving && !cue.arrived) || cue.key === guidanceSpoken.current.key) return;
      if (!cue.arrived && Date.now() - guidanceSpoken.current.at < 4000) return;
      const signal = turn.current.begin();
      guidanceSpoken.current = { key: cue.key, at: Date.now() };
      busy.current = true;
      if (!cue.arrived) setNavigation("guiding");
      setReply(cue.text);
      try { await say(cue.text, signal, current); }
      catch (error) { if (!signal.aborted && session.current === current) setError(error instanceof Error ? error.message : "Could not speak directions."); }
      finally { if (!signal.aborted && session.current === current) { busy.current = false; setOutput(null); setPhase("idle"); } }
    }, 750);
    return () => clearInterval(timer);
  }, [say, stop]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (!session.current?.connected) return;
      const { model_id, start, heading_deg, speed_mps, walking_speed_mps, moving, observed_at, current_item_id } = latest.current.context();
      voiceSocket.updateState({ model_id, start, heading_deg, speed_mps, walking_speed_mps, moving, observed_at, current_item_id });
    }, 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") interrupt();
    };
    const takeOver = (event: PointerEvent) => {
      // Manual scene controls stop autonomous movement, while spoken guidance
      // continues following the visitor's position instead of being cut off.
      if ((event.target as HTMLElement | null)?.closest(".scene canvas")) latest.current.stop();
    };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", stop);
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

  return { phase, progress, navigation, interrupted, error: error ?? microphone.state.error, analyser: output ?? microphone.state.analyser, transcript, reply, start, stop, interrupt };
}
