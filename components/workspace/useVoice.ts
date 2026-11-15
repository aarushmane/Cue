"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioFormat, CommitStrategy, RealtimeEvents, Scribe, type RealtimeConnection } from "@elevenlabs/client";
import { useMicrophone, type MicrophoneCapture } from "./useMicrophone";
import { isStopCommand, VoiceTurn, type VoiceEvent, type VoiceMessage, type VoiceResult } from "@/lib/voice/types";
import { playSpeech } from "@/lib/voice/playback";
import { wakeCommand, type VoicePreferences } from "@/lib/voice/preferences";
import type { GuidanceSnapshot } from "@/lib/voice/guidance";
import { voiceSocket } from "@/lib/voice/socket";
import { normalize } from "@/lib/search/matchProducts";
import type { VoiceClarification } from "@/lib/voice/clarification";

export type VoiceBridge = {
  context: () => Record<string, unknown>;
  apply: (result: VoiceResult) => void;
  stop: () => void;
  moving: () => boolean;
  guidance: () => GuidanceSnapshot | null;
  /** The visitor has reached the item: stop movement and end the route. */
  arrive: () => void;
};
/** The visitor must stay still, close by and looking at the item this long before navigation ends. */
const ARRIVE_HOLD_MS = 700;
/**
 * One tap of the microphone is one session: the microphone transcribes a single request (closing once the visitor
 * stops speaking), then the session stays alive only for the reply, any clarifying question, and spoken directions.
 */
type Session = {
  abort: AbortController; capture?: MicrophoneCapture; connection?: RealtimeConnection; input?: AudioWorkletNode;
  timeout?: ReturnType<typeof setTimeout>; idle?: ReturnType<typeof setTimeout>; connected: boolean;
};
export type VoicePhase = "off" | "connecting" | "listening" | "thinking" | "speaking" | "idle";
export type VoiceLogEntry = { id: number; role: "you" | "cue"; text: string };
const LOG_LIMIT = 50;

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
  const session = useRef<Session | null>(null);
  const turn = useRef(new VoiceTurn());
  const busy = useRef(false);
  const history = useRef<VoiceMessage[]>([]);
  const listenRef = useRef<(current: Session) => Promise<void>>(async () => {});
  /** A request already heard with the wake phrase ("Hey Cue, where's the milk"), sent once transcription connects. */
  const spoken = useRef<string | null>(null);
  const [phase, setPhase] = useState<VoicePhase>("off");
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [output, setOutput] = useState<AnalyserNode | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [progress, setProgress] = useState<Extract<VoiceEvent, { type: "progress" }> | null>(null);
  const [navigation, setNavigation] = useState<"idle" | "guiding" | "arrived">("idle");
  const [log, setLog] = useState<VoiceLogEntry[]>([]);
  const logId = useRef(0);
  const record = useCallback((role: VoiceLogEntry["role"], text: string) => {
    const clean = text.trim();
    if (clean) setLog((previous) => [...previous, { id: ++logId.current, role, text: clean }].slice(-LOG_LIMIT));
  }, []);
  // Spoken answers to typed searches play on their own audio context, with no microphone involved.
  const announcer = useRef<{ context: AudioContext | null; abort: AbortController | null }>({ context: null, abort: null });
  const silenceAnnouncement = useCallback(() => { announcer.current.abort?.abort(); announcer.current.abort = null; }, []);

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
    silenceAnnouncement();
    resetUtterance();
    turn.current.cancel();
    busy.current = false;
    latest.current.stop();
    setOutput(null);
    setInterrupted(true);
    setProgress(null);
    setNavigation("idle");
    const current = session.current;
    setPhase(!current ? "off" : current.connection ? current.connected ? "listening" : "connecting" : "idle");
  }, [resetUtterance, silenceAnnouncement]);

  const dispose = useCallback(() => {
    silenceAnnouncement();
    turn.current.cancel();
    busy.current = false;
    latest.current.stop();
    const old = session.current;
    session.current = null;
    clarification.current = null;
    resetUtterance();
    history.current = [];
    lastSpeech.current = { text: "", at: 0, playing: false };
    old?.abort.abort();
    if (old) stopListening(old);
  }, [resetUtterance, stopListening, silenceAnnouncement]);

  /** End the session. The last request and reply stay on screen. */
  const stop = useCallback(() => {
    dispose(); stopMicrophone(); setPhase("off"); setOutput(null); setInterrupted(false); setProgress(null); setNavigation("idle");
  }, [dispose, stopMicrophone]);

  /** End the microphone session once its request is handled, leaving movement and spoken directions running. */
  const release = useCallback(() => {
    const old = session.current;
    if (!old) return;
    session.current = null;
    old.abort.abort();
    stopListening(old);
    stopMicrophone();
    clarification.current = null;
    resetUtterance();
    setPhase("off");
  }, [stopListening, stopMicrophone, resetUtterance]);

  /** Stop speech and movement. With nothing left to do, the session then ends on its own. */
  const interrupt = useCallback(() => {
    clarification.current = null;
    if (session.current) stopListening(session.current);
    cancelWork();
  }, [cancelWork, stopListening]);

  const say = useCallback(async (text: string, signal: AbortSignal, current: Session) => {
    if (!current.capture || !options.current.spokenResponses) return;
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
    record("you", text);
    setError(null);
    const signal = turn.current.begin();
    busy.current = true;
    let reopen = false;
    try {
      if (isStopCommand(text)) {
        setReply("Stopped.");
        record("cue", "Stopped.");
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
      record("cue", result.reply);
      history.current = [...history.current, { role: "user", content: text.slice(0, 300) }, { role: "assistant", content: result.reply }].slice(-8) as VoiceMessage[];
      // Start walking while the reply is spoken rather than after it; spoken directions wait for the reply to end.
      if (movement.length) {
        if (result.plan?.status === "ALREADY_THERE") {
          latest.current.apply({ ...result, actions: [{ type: "face", target: "destination" }] });
          setNavigation("arrived");
        } else {
          latest.current.apply({ ...result, actions: movement });
          setNavigation("guiding");
        }
      }
      await say(result.reply, signal, current);
      signal.throwIfAborted();
      if (result.clarification) {
        // A question gets one more listening turn, without another tap.
        clarification.current = result.clarification;
        reopen = true;
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
  }, [cancelWork, resetUtterance, say, stopListening, record]);

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
        const heard = spoken.current;
        spoken.current = null;
        if (heard && normalize(heard)) void submit(heard);
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

  /** Open a microphone session. `heard`: a request the wake listener already caught, sent without asking again. */
  const start = useCallback(async (heard?: string) => {
    stop();
    spoken.current = heard?.trim() || null;
    setError(null);
    setTranscript("");
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

  /** Speak an answer to a typed search. Never starts movement and never opens the microphone. */
  const announce = useCallback(async (text: string, query?: string) => {
    if (query) record("you", query);
    record("cue", text);
    setReply(text);
    setError(null);
    if (session.current) cancelWork();
    silenceAnnouncement();
    if (!options.current.spokenResponses || !text.trim()) return;
    const abort = new AbortController();
    announcer.current.abort = abort;
    const context = announcer.current.context && announcer.current.context.state !== "closed" ? announcer.current.context : new AudioContext();
    announcer.current.context = context;
    setPhase((phase) => phase === "off" ? "speaking" : phase);
    try { await playSpeech(text, context, abort.signal, (analyser) => { if (!abort.signal.aborted) setOutput(analyser); }, options.current); }
    catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "Could not play voice."); }
    finally {
      if (announcer.current.abort === abort) {
        announcer.current.abort = null;
        setOutput(null);
        setPhase((phase) => !session.current && phase === "speaking" ? "off" : phase);
      }
    }
  }, [record, cancelWork, silenceAnnouncement]);
  useEffect(() => () => { void announcer.current.context?.close().catch(() => {}); }, []);

  /**
   * Spoken directions, for any route (voice or typed), on their own audio context so no microphone is needed:
   * a full sentence when the visitor stops, a few words every 4 s while walking, and a framing hint when they are
   * near the item but it isn't roughly centred in view. Never talks over listening, thinking or a reply.
   */
  const guide = useRef({ wasMoving: false, stoppedAt: 0, pendingStop: false, lastEnd: 0, framing: "", offSince: 0, speaking: false, arriveSince: 0 });
  const speakCue = useCallback(async (text: string, log: boolean) => {
    const g = guide.current;
    silenceAnnouncement();
    const abort = new AbortController();
    announcer.current.abort = abort;
    g.speaking = true;
    if (log) record("cue", text);
    const context = announcer.current.context && announcer.current.context.state !== "closed" ? announcer.current.context : new AudioContext();
    announcer.current.context = context;
    try { await playSpeech(text, context, abort.signal, (analyser) => { if (!abort.signal.aborted) setOutput(analyser); }, options.current); }
    catch (error) { if (!abort.signal.aborted) setError(error instanceof Error ? error.message : "Could not speak directions."); }
    finally {
      if (announcer.current.abort === abort) { announcer.current.abort = null; setOutput(null); }
      g.speaking = false;
      g.lastEnd = Date.now();
    }
  }, [record, silenceAnnouncement]);

  useEffect(() => {
    const timer = setInterval(() => {
      const g = guide.current;
      const current = session.current;
      // The microphone session ends as soon as its request is handled; walking and directions carry on without it.
      if (current?.connected && !current.connection && !busy.current && !clarification.current && !utterance.current.text) release();
      const moving = latest.current.moving();
      const now = Date.now();
      if (g.wasMoving && !moving) { g.pendingStop = true; g.stoppedAt = now; }
      g.wasMoving = moving;
      if (moving) g.pendingStop = false;
      const snap = latest.current.guidance();
      if (!snap) { g.pendingStop = false; g.offSince = 0; g.framing = ""; g.arriveSince = 0; return; }
      if (moving) setNavigation((value) => value === "guiding" ? value : "guiding");
      const speak = options.current.guidance && options.current.spokenResponses;
      const quiet = !session.current && !announcer.current.abort && !busy.current && !g.speaking;
      // Reached the item (close by, still and looking at it, at any eye height): end navigation, whatever the
      // speech settings, once that has held for a moment.
      if (snap.cue.arrived && !moving) {
        if (!g.arriveSince) g.arriveSince = now;
        if (now - g.arriveSince < ARRIVE_HOLD_MS) return;
        g.arriveSince = 0; g.pendingStop = false; g.offSince = 0; g.framing = "";
        latest.current.arrive();
        setNavigation("arrived");
        if (speak && quiet) void speakCue(snap.cue.text, true);
        else record("cue", snap.cue.text);
        return;
      }
      g.arriveSince = 0;
      if (!speak || !quiet) return;
      // Stopped (and still for a moment, so pauses between key presses don't count).
      if (g.pendingStop && now - g.stoppedAt >= 400) {
        g.pendingStop = false;
        const text = snap.framing ?? snap.cue.text;
        g.framing = snap.framing ?? "";
        void speakCue(text, true);
        return;
      }
      if (moving) {
        g.offSince = 0;
        if (snap.brief && now - g.lastEnd >= 4000) void speakCue(snap.brief, false);
        return;
      }
      // Standing near the item, facing away from it: say where it is (again only if it changed, or after 8 s).
      if (!snap.framing) { g.offSince = 0; g.framing = ""; return; }
      if (!g.offSince) g.offSince = now;
      const repeat = snap.framing !== g.framing ? 4000 : 8000;
      if (now - g.offSince >= 600 && now - g.lastEnd >= repeat) { g.framing = snap.framing; void speakCue(snap.framing, true); }
    }, 250);
    return () => clearInterval(timer);
  }, [release, speakCue, record]);

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

  return { phase, progress, navigation, interrupted, error: error ?? microphone.state.error, analyser: output ?? microphone.state.analyser, transcript, reply, log, start, stop, interrupt, announce };
}
