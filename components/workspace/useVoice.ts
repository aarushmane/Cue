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

export type VoiceBridge = {
  context: () => Record<string, unknown>;
  apply: (result: VoiceResult) => void;
  stop: () => void;
  moving: () => boolean;
  guidance: () => GuidanceCue | null;
};
type Session = { abort: AbortController; capture?: MicrophoneCapture; connection?: RealtimeConnection; input?: AudioWorkletNode; timeout?: ReturnType<typeof setTimeout>; connected: boolean };
type Phase = "off" | "connecting" | "listening" | "thinking" | "speaking";

function joinSpeech(previous: string, next: string) {
  const a = previous.trim().split(/\s+/).filter(Boolean), b = next.trim().split(/\s+/).filter(Boolean);
  for (let n = Math.min(a.length, b.length); n > 0; n--) {
    if (a.slice(-n).join(" ").toLowerCase() === b.slice(0, n).join(" ").toLowerCase()) return [...a, ...b.slice(n)].join(" ");
  }
  return [...a, ...b].join(" ");
}

export function useVoice(bridge: VoiceBridge, preferences: VoicePreferences) {
  const microphone = useMicrophone();
  const { start: startMicrophone, stop: stopMicrophone } = microphone;
  const latest = useRef(bridge);
  useEffect(() => { latest.current = bridge; }, [bridge]);
  const options = useRef(preferences);
  useEffect(() => { options.current = preferences; }, [preferences]);
  const activated = useRef(false);
  const utterance = useRef({ text: "", timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const lastSpeech = useRef({ text: "", at: 0, playing: false });
  const wasMoving = useRef(false);
  const guidanceSpoken = useRef({ key: "", at: 0 });
  const session = useRef<Session | null>(null);
  const turn = useRef(new VoiceTurn());
  const busy = useRef(false);
  const history = useRef<VoiceMessage[]>([]);
  const speechIntent = useRef<"pending" | "accepted" | "blocked">("pending");
  const [phase, setPhase] = useState<Phase>("off");
  const [listeningOpen, setListeningOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [output, setOutput] = useState<AnalyserNode | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [progress, setProgress] = useState<Extract<VoiceEvent, { type: "progress" }> | null>(null);
  const [navigation, setNavigation] = useState<"idle" | "guiding" | "arrived">("idle");

  const interrupt = useCallback(() => {
    clearTimeout(utterance.current.timer);
    utterance.current.text = "";
    turn.current.cancel();
    busy.current = false;
    wasMoving.current = false;
    latest.current.stop();
    setOutput(null);
    setInterrupted(true);
    setProgress(null);
    setNavigation("idle");
    setPhase(session.current?.connected ? "listening" : session.current ? "connecting" : "off");
  }, []);

  const dispose = useCallback(() => {
    turn.current.cancel();
    busy.current = false;
    latest.current.stop();
    const old = session.current;
    session.current = null;
    activated.current = false;
    clearTimeout(utterance.current.timer);
    utterance.current.text = "";
    speechIntent.current = "pending";
    wasMoving.current = false;
    old?.abort.abort();
    clearTimeout(old?.timeout);
    old?.connection?.close();
    if (old?.input) { old.input.port.onmessage = null; old.input.disconnect(); }
  }, []);
  const stop = useCallback(() => {
    dispose(); stopMicrophone(); setPhase("off"); setListeningOpen(false); setOutput(null); setTranscript(""); setInterrupted(false); setProgress(null); setNavigation("idle");
  }, [dispose, stopMicrophone]);

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

  const echo = useCallback((text: string) => {
    if (wakeCommand(text).wake) return false;
    const spoken = lastSpeech.current;
    if (!spoken.playing && Date.now() - spoken.at > 2000) return false;
    const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const input = words(text), output = words(spoken.text);
    return input.length > 0 && input.filter((word) => output.includes(word)).length / input.length >= 0.8;
  }, []);

  const accept = useCallback((text: string) => {
    const wake = wakeCommand(text);
    if (wake.wake) { activated.current = true; setListeningOpen(true); }
    if (isStopCommand(wake.command)) return wake.command;
    return !options.current.wakeWord || activated.current ? wake.command : null;
  }, []);

  const submit = useCallback(async (raw: string, approved = false) => {
    const current = session.current;
    const text = approved ? wakeCommand(raw).command : accept(raw);
    if (!current?.connected || text === null) return;
    if (!text) { interrupt(); return; }
    interrupt();
    setInterrupted(false);
    setTranscript(text);
    setError(null);
    const signal = turn.current.begin();
    busy.current = true;
    try {
      if (isStopCommand(text)) {
        // No model latency on stop. The local VAD has already stopped motion/speech.
        setReply("Stopped.");
        await say("Stopped.", signal, current);
        if (!signal.aborted) setInterrupted(true);
        return;
      }
      setPhase("thinking");
      setProgress({ type: "progress", stage: "loading", label: "Loading scene" });
      const result = await voiceSocket.request<VoiceResult>("turn", {
        ...latest.current.context(), query: text.slice(0, 300), history: history.current.slice(-8),
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
      if (!signal.aborted && session.current === current) { busy.current = false; setPhase("listening"); setOutput(null); setProgress(null); }
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
      const data = await voiceSocket.request<{ token: string }>("token", {}, current.abort.signal);
      current.abort.signal.throwIfAborted();
      await capture.context.audioWorklet.addModule("/audio/voice-input.js");
      current.abort.signal.throwIfAborted();
      const connection = Scribe.connect({ token: data.token, modelId: "scribe_v2_realtime", audioFormat: AudioFormat.PCM_16000,
        sampleRate: 16000, commitStrategy: CommitStrategy.VAD, vadSilenceThresholdSecs: 0.6,
        keyterms: ["Hey Cue", "Cue"] });
      current.connection = connection;
      const fail = (message: string) => {
        if (session.current !== current) return;
        stop(); setError(message);
      };
      current.timeout = setTimeout(() => fail("Voice connection timed out. Enable the microphone to try again."), 15_000);
      connection.on(RealtimeEvents.SESSION_STARTED, () => {
        if (session.current !== current) { connection.close(); return; }
        current.connected = true;
        activated.current = !options.current.wakeWord;
        setListeningOpen(activated.current);
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
            if (activated.current && !lastSpeech.current.playing && (busy.current || latest.current.moving())) interrupt();
          }
          try {
            const bytes = new Uint8Array(data.pcm);
            connection.send({ audioBase64: btoa(String.fromCharCode(...bytes)), sampleRate: 16000 });
          } catch { fail("Voice connection lost. Enable the microphone to reconnect."); }
        };
        capture.source.connect(input);
        input.connect(capture.context.destination); // Worklet emits silence, never the microphone signal.
        setPhase("listening");
        setInterrupted(false);
        // Audible confirmation also verifies that output is unlocked and the selected voice works.
        const ready = turn.current.begin();
        busy.current = true;
        void say(options.current.wakeWord ? "Ready." : "I'm listening.", ready, current).catch((error: unknown) => {
          if (!ready.aborted && session.current === current) setError(error instanceof Error ? error.message : "Could not play voice. Check voice settings.");
        }).finally(() => {
          if (!ready.aborted && session.current === current) { busy.current = false; setOutput(null); setPhase("listening"); }
        });
      });
      // VAD can commit "Hey" separately from "Cue". Retain only that exact
      // opening briefly, within this connection, rather than joining background speech.
      let wakePrefixUntil = 0;
      let completingWake = false;
      const withWakePrefix = (text: string) => {
        const combined = `Hey ${text}`;
        if ((completingWake || Date.now() < wakePrefixUntil) && !wakeCommand(text).wake && wakeCommand(combined).wake) {
          completingWake = true; // Keep the prefix through the final transcript of a long request.
          return combined;
        }
        return text;
      };
      connection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, ({ text: raw }) => {
        if (session.current !== current || !raw.trim()) return;
        const text = withWakePrefix(raw);
        clearTimeout(utterance.current.timer); // A pause is not a completed request if speech resumes.
        if (echo(text)) { speechIntent.current = "blocked"; return; }
        const command = accept(text);
        if (command === null) { speechIntent.current = "blocked"; setTranscript(raw); return; }
        speechIntent.current = "accepted";
        if (busy.current || latest.current.moving() || isStopCommand(command)) interrupt();
        if (command && !isStopCommand(command)) setInterrupted(false);
        setTranscript(joinSpeech(utterance.current.text, command));
      });
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text: raw }) => {
        if (session.current !== current || !raw.trim()) return;
        const text = withWakePrefix(raw);
        completingWake = false;
        const wake = wakeCommand(text);
        const explicit = wake.wake || isStopCommand(wake.command);
        const intent = speechIntent.current;
        speechIntent.current = "pending";
        // Don't accept a delayed echo just because output finished before its final transcript.
        if (echo(text)) return;
        wakePrefixUntil = /^[\s\p{P}]*hey[\s\p{P}]*$/iu.test(raw) ? Date.now() + 2500 : 0;
        if (intent === "blocked" && !explicit) {
          if (options.current.wakeWord && !activated.current) setTranscript(raw);
          return;
        }
        const command = accept(text);
        if (command === null) { setTranscript(raw); return; }
        if (!command) { interrupt(); setTranscript(raw); return; }
        clearTimeout(utterance.current.timer);
        if (isStopCommand(command)) { utterance.current.text = ""; void submit(command, true); return; }
        utterance.current.text = joinSpeech(utterance.current.text, command);
        setTranscript(utterance.current.text);
        // Scribe's VAD commit can split a natural sentence. Collect adjacent commits,
        // and reset this grace period on every partial before starting any tools.
        utterance.current.timer = setTimeout(() => {
          const complete = utterance.current.text;
          // Keep incomplete openings across longer pauses too ("can you find me ...").
          if (!normalize(complete) || /\b(?:to|for|and|the|a|an|some|me)[,.!?\s]*$/i.test(complete)) return;
          utterance.current.text = "";
          if (session.current === current && complete) void submit(complete, true);
        }, 1100);
      });
      connection.on(RealtimeEvents.ERROR, () => fail("ElevenLabs transcription failed. Check your key, speech-to-text permissions and quota, then reconnect."));
      connection.on(RealtimeEvents.CLOSE, () => fail("Voice disconnected. Enable the microphone to reconnect."));
    } catch (error) {
      if (session.current !== current) return;
      stop(); setError(error instanceof Error ? error.message : "Could not start voice.");
    }
  }, [stop, dispose, startMicrophone, interrupt, submit, accept, say, echo]);

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
      if (!current?.connected || !options.current.guidance || !options.current.spokenResponses) return;
      const moving = latest.current.moving();
      const justStopped = wasMoving.current && !moving;
      wasMoving.current = moving;
      const cue = latest.current.guidance();
      if (cue?.arrived && moving) return; // Wait for the final facing motion before announcing arrival.
      if (cue?.arrived && !moving && justStopped && cue.key !== guidanceSpoken.current.key) {
        turn.current.cancel(); // Arrival takes precedence over a stale "continue ahead" response.
        busy.current = false;
        // The renderer has finished walking AND facing the product. Preserve that orientation.
        wasMoving.current = false;
        setNavigation("arrived");
      } else if (busy.current || (!moving && !justStopped)) return;
      if (!cue || (!moving && !cue.arrived) || cue.key === guidanceSpoken.current.key) return;
      if (!cue.arrived && Date.now() - guidanceSpoken.current.at < 4000) return;
      const signal = turn.current.begin();
      guidanceSpoken.current = { key: cue.key, at: Date.now() };
      busy.current = true;
      if (!cue.arrived) setNavigation("guiding");
      setReply(cue.text);
      try { await say(cue.text, signal, current); }
      catch (error) { if (!signal.aborted && session.current === current) setError(error instanceof Error ? error.message : "Could not speak directions."); }
      finally { if (!signal.aborted && session.current === current) { busy.current = false; setOutput(null); setPhase("listening"); } }
    }, 750);
    return () => clearInterval(timer);
  }, [say]);

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

  return { phase, progress, navigation, listeningOpen: listeningOpen || !preferences.wakeWord, interrupted, error: error ?? microphone.state.error, analyser: output ?? microphone.state.analyser, transcript, reply, start, stop, interrupt, replay };
}
