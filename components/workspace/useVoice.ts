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
import { clarificationAnswer, type VoiceClarification } from "@/lib/voice/clarification";

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
  const activationTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const activationDeadline = useRef(0);
  const clarification = useRef<VoiceClarification | null>(null);
  const utterance = useRef({ text: "", timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const lastSpeech = useRef({ text: "", at: 0, playing: false, interrupted: false });
  const wasMoving = useRef(false);
  const guidanceSpoken = useRef({ key: "", at: 0 });
  const session = useRef<Session | null>(null);
  const turn = useRef(new VoiceTurn());
  const busy = useRef(false);
  const history = useRef<VoiceMessage[]>([]);
  const speechIntent = useRef<"pending" | "accepted" | "blocked" | "protected">("pending");
  const [phase, setPhase] = useState<Phase>("off");
  const [listeningOpen, setListeningOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [output, setOutput] = useState<AnalyserNode | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [progress, setProgress] = useState<Extract<VoiceEvent, { type: "progress" }> | null>(null);
  const [navigation, setNavigation] = useState<"idle" | "guiding" | "arrived">("idle");

  const closeListening = useCallback(() => {
    clearTimeout(activationTimer.current);
    activationDeadline.current = 0;
    clarification.current = null;
    activated.current = !options.current.wakeWord;
    setListeningOpen(activated.current);
  }, []);

  const openClarification = useCallback((question: VoiceClarification) => {
    clarification.current = question;
    activated.current = true;
    activationDeadline.current = Date.now() + 15_000;
    setListeningOpen(true);
    clearTimeout(activationTimer.current);
    activationTimer.current = setTimeout(closeListening, 10_000);
  }, [closeListening]);

  useEffect(() => {
    clearTimeout(utterance.current.timer);
    utterance.current.text = "";
    speechIntent.current = "pending";
    closeListening();
  }, [preferences.wakeWord, closeListening]);

  const cancelWork = useCallback(() => {
    clearTimeout(utterance.current.timer);
    utterance.current.text = "";
    lastSpeech.current.interrupted = true;
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

  const interrupt = useCallback(() => {
    closeListening();
    cancelWork();
  }, [closeListening, cancelWork]);

  const dispose = useCallback(() => {
    turn.current.cancel();
    busy.current = false;
    latest.current.stop();
    const old = session.current;
    session.current = null;
    activated.current = false;
    clearTimeout(activationTimer.current);
    activationDeadline.current = 0;
    clarification.current = null;
    clearTimeout(utterance.current.timer);
    utterance.current.text = "";
    speechIntent.current = "pending";
    history.current = [];
    lastSpeech.current = { text: "", at: 0, playing: false, interrupted: false };
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
    const spoken = { text, at: Date.now(), playing: true, interrupted: false };
    lastSpeech.current = spoken;
    try { await playSpeech(text, current.capture.context, signal, (analyser) => {
      if (!signal.aborted && session.current === current) setOutput(analyser);
    }, options.current); }
    finally { spoken.playing = false; spoken.at = Date.now(); }
  }, []);

  const echo = useCallback((text: string, includeDelayed = false) => {
    if (wakeCommand(text).wake) return false;
    const spoken = lastSpeech.current;
    if (!includeDelayed && !spoken.playing && Date.now() - spoken.at > 1000) return false;
    const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const input = words(text), output = words(spoken.text);
    return input.length > 0 && input.filter((word) => output.includes(word)).length / input.length >= 0.8;
  }, []);

  const accept = useCallback((text: string) => {
    const wake = wakeCommand(text);
    if (isStopCommand(wake.command)) return wake.command;
    if (!wake.wake && clarification.current && clarificationAnswer(wake.command, clarification.current) === null) return null;
    if (wake.wake) {
      clarification.current = null;
      if (!activated.current) activationDeadline.current = Date.now() + 15_000;
      activated.current = true;
      setListeningOpen(true);
      setError(null);
    }
    if (options.current.wakeWord && !activated.current) return null;
    if (options.current.wakeWord) {
      // One wake phrase opens one request, with time for pauses between words.
      // An unfinished request must not leave the microphone accepting room speech.
      clearTimeout(activationTimer.current);
      activationTimer.current = setTimeout(() => {
        const wasQuestion = Boolean(clarification.current);
        closeListening();
        clearTimeout(utterance.current.timer);
        utterance.current.text = "";
        speechIntent.current = "pending";
        if (!wasQuestion) setError("I didn't catch a complete request. Say Hey Cue and try again.");
      }, Math.max(0, Math.min(8000, activationDeadline.current - Date.now())));
    }
    return wake.command;
  }, [closeListening]);

  const submit = useCallback(async (raw: string, approved = false) => {
    const current = session.current;
    const text = approved ? wakeCommand(raw).command : accept(raw);
    if (!current?.connected || text === null) return;
    if (!text) { interrupt(); return; }
    const answering = !wakeCommand(raw).wake ? clarification.current : null;
    interrupt();
    setInterrupted(false);
    setTranscript(text);
    setError(null);
    const signal = turn.current.begin();
    busy.current = true;
    try {
      if (isStopCommand(text)) {
        // No model latency on stop. The accepted transcript already stopped motion/speech.
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
      if (result.clarification) openClarification(result.clarification);
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
  }, [interrupt, say, accept, openClarification]);

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
        sampleRate: 16000, commitStrategy: CommitStrategy.VAD, vadSilenceThresholdSecs: 0.9,
        filterBackgroundAudio: true, keyterms: ["Hey Cue", "Cue"] });
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
        input.port.onmessage = ({ data }: MessageEvent<{ pcm: ArrayBuffer }>) => {
          if (session.current !== current) return;
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
      const protectingOutput = () => !lastSpeech.current.interrupted && (lastSpeech.current.playing || Date.now() - lastSpeech.current.at < 1000);
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
        const wake = wakeCommand(text);
        const answering = !busy.current && clarification.current && clarificationAnswer(wake.command, clarification.current) !== null;
        const explicit = wake.wake || isStopCommand(wake.command) || answering;
        // Protect reasoning as well as playback. A nearby conversation must not
        // silently cancel a search, even when wake-word prompting is disabled.
        if (!explicit && (busy.current || protectingOutput() || speechIntent.current === "protected")) {
          speechIntent.current = "protected";
          return;
        }
        if (!answering && echo(text)) { speechIntent.current = "blocked"; return; }
        const command = accept(text);
        if (command === null) { speechIntent.current = "blocked"; return; }
        clearTimeout(utterance.current.timer); // Accepted speech resumes; ignored echo must not strand a queued request.
        speechIntent.current = "accepted";
        if (busy.current || latest.current.moving() || isStopCommand(command)) cancelWork();
        if (command && !isStopCommand(command)) setInterrupted(false);
        setTranscript(joinSpeech(utterance.current.text, command));
      });
      connection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, ({ text: raw }) => {
        if (session.current !== current || !raw.trim()) return;
        const text = withWakePrefix(raw);
        completingWake = false;
        const wake = wakeCommand(text);
        const answering = !busy.current && clarification.current && clarificationAnswer(wake.command, clarification.current) !== null;
        const explicit = wake.wake || isStopCommand(wake.command) || answering;
        const intent = speechIntent.current;
        speechIntent.current = "pending";
        // Preserve a split wake phrase even when its opening is heard over output.
        wakePrefixUntil = /^[\s\p{P}]*hey[\s\p{P}]*$/iu.test(raw) ? Date.now() + 2500 : 0;
        // Keep ignoring the whole segment even if its final arrives after work finishes.
        if (!explicit && (intent === "protected" || busy.current || protectingOutput())) return;
        // Don't accept a delayed echo just because output finished before its final transcript.
        if (!answering && (echo(text) || (intent === "blocked" && !explicit && echo(text, true)))) return;
        // Re-evaluate the final words: an early partial may have looked like echo
        // or lacked the wake phrase before Scribe corrected it.
        const command = accept(text);
        if (command === null) return;
        if (!command) { cancelWork(); setTranscript(raw); return; }
        clearTimeout(utterance.current.timer);
        if (isStopCommand(command)) { utterance.current.text = ""; void submit(command, true); return; }
        utterance.current.text = joinSpeech(utterance.current.text, command);
        setTranscript(utterance.current.text);
        // Scribe's VAD commit can split a natural sentence. Collect adjacent commits,
        // and reset this grace period on every partial before starting any tools.
        utterance.current.timer = setTimeout(() => {
          const complete = utterance.current.text;
          // Keep incomplete openings across longer pauses too ("can you find me ...").
          if (!normalize(complete) || /[-–—…]\s*$/.test(complete) || /\b(?:to|for|and|the|a|an|some|me)[\p{P}\s]*$/iu.test(complete)) return;
          utterance.current.text = "";
          if (session.current === current && complete) void submit(complete, true);
        }, 1400);
      });
      connection.on(RealtimeEvents.ERROR, () => fail("ElevenLabs transcription failed. Check your key, speech-to-text permissions and quota, then reconnect."));
      connection.on(RealtimeEvents.CLOSE, () => fail("Voice disconnected. Enable the microphone to reconnect."));
    } catch (error) {
      if (session.current !== current) return;
      stop(); setError(error instanceof Error ? error.message : "Could not start voice.");
    }
  }, [stop, dispose, startMicrophone, cancelWork, submit, accept, say, echo]);

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
      // A pause between transcription segments must not let guidance start talking
      // over the visitor, or clear the already collected part of their request.
      if (busy.current || clarification.current || utterance.current.text || speechIntent.current === "accepted") return;
      const moving = latest.current.moving();
      const justStopped = wasMoving.current && !moving;
      wasMoving.current = moving;
      const cue = latest.current.guidance();
      if (cue?.arrived && moving) return; // Wait for the final facing motion before announcing arrival.
      if (cue?.arrived && !moving && justStopped && cue.key !== guidanceSpoken.current.key) {
        wasMoving.current = false;
        setNavigation("arrived");
      } else if (!moving && !justStopped) return;
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

  return { phase, progress, navigation, listeningOpen: listeningOpen || !preferences.wakeWord, interrupted, error: error ?? microphone.state.error, analyser: output ?? microphone.state.analyser, transcript, reply, start, stop, interrupt, replay };
}
