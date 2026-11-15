"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type MicrophoneState =
  | { status: "off" | "requesting"; analyser: null; error: null }
  | { status: "listening"; analyser: AnalyserNode; error: null }
  | { status: "error"; analyser: null; error: string };

export type MicrophoneCapture = { stream: MediaStream; context: AudioContext; source: MediaStreamAudioSourceNode; analyser: AnalyserNode };
type Capture = MicrophoneCapture;

function release(capture: Capture | null) {
  if (!capture) return;
  capture.source.disconnect();
  capture.stream.getTracks().forEach((track) => track.stop());
  if (capture.context.state !== "closed") void capture.context.close().catch(() => {});
}

function messageFor(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "Microphone access is blocked. Allow it in your browser and try again.";
  if (name === "NotFoundError") return "No microphone found. Connect one and try again.";
  if (name === "NotReadableError") return "The microphone is unavailable. Check whether another app is using it.";
  return "Could not start the microphone. Please try again.";
}

export function useMicrophone() {
  const [state, setState] = useState<MicrophoneState>({ status: "off", analyser: null, error: null });
  const capture = useRef<Capture | null>(null);
  const generation = useRef(0);

  const dispose = useCallback(() => {
    generation.current++;
    const previous = capture.current;
    capture.current = null;
    release(previous);
  }, []);

  const stop = useCallback(() => {
    dispose();
    setState({ status: "off", analyser: null, error: null });
  }, [dispose]);

  useEffect(() => {
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", hide);
    window.addEventListener("pagehide", stop);
    return () => {
      dispose();
      document.removeEventListener("visibilitychange", hide);
      window.removeEventListener("pagehide", stop);
    };
  }, [dispose, stop]);

  const start = useCallback(async () => {
    const attempt = ++generation.current;
    release(capture.current);
    capture.current = null;
    setState({ status: "requesting", analyser: null, error: null });
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioContext) {
      setState({ status: "error", analyser: null, error: "Microphone input requires a supported browser on HTTPS or localhost." });
      return;
    }
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false }, video: false,
      });
      // A permission prompt can resolve after Stop, unmount, or navigating away.
      if (attempt !== generation.current) { stream.getTracks().forEach((track) => track.stop()); return; }
      context = new AudioContext({ sampleRate: 16000 });
      source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      analyser.minDecibels = -85;
      analyser.maxDecibels = -20;
      analyser.smoothingTimeConstant = 0.55;
      source.connect(analyser); // No speaker connection: no monitoring or feedback.
      capture.current = { stream, context, source, analyser };
      stream.getAudioTracks().forEach((track) => track.addEventListener("ended", () => {
        if (attempt === generation.current) stop();
      }, { once: true }));
      await context.resume();
      if (attempt !== generation.current) return;
      setState({ status: "listening", analyser, error: null });
      return capture.current;
    } catch (error) {
      source?.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") void context.close().catch(() => {});
      if (attempt !== generation.current) return;
      capture.current = null;
      setState({ status: "error", analyser: null, error: messageFor(error) });
    }
  }, [stop]);

  return { state, start, stop };
}
