import { voiceSocket } from "./socket";

/** Decode streamed little-endian PCM16 without waiting for an entire utterance to download. */
export function pcmFloats(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const data = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const samples = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = data.getInt16(i * 2, true) / 32768;
  return samples;
}

export async function playSpeech(text: string, context: AudioContext, signal: AbortSignal, onOutput: (analyser: AnalyserNode | null) => void,
  preferences?: { voiceId: string; speed: number }) {
  signal.throwIfAborted();
  const sources = new Set<AudioBufferSourceNode>();
  const analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.connect(context.destination);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let finish = () => {};
  const silence = () => {
    for (const source of sources) { source.onended = null; try { source.stop(); } catch {} source.disconnect(); }
    sources.clear();
    analyser.disconnect();
    void reader?.cancel().catch(() => {});
    finish();
  };
  signal.addEventListener("abort", silence, { once: true });
  try {
    const audio = await voiceSocket.speech({ text,
      ...(preferences?.voiceId ? { voice_id: preferences.voiceId } : {}), speed: preferences?.speed ?? 1,
    }, signal);
    signal.throwIfAborted();
    onOutput(analyser);
    await context.resume();
    reader = audio.getReader();
    let tail = new Uint8Array(0);
    let at = context.currentTime + 0.06;
    const drained = new Promise<void>((resolve) => { finish = resolve; });
    let ended = false;
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      const bytes = new Uint8Array(tail.length + chunk.value.length);
      bytes.set(tail); bytes.set(chunk.value, tail.length);
      const length = bytes.length - (bytes.length % 2);
      tail = bytes.slice(length);
      if (!length) continue;
      const samples = pcmFloats(bytes.subarray(0, length));
      const buffer = context.createBuffer(1, samples.length, 24000);
      buffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(analyser);
      sources.add(source);
      source.onended = () => { sources.delete(source); source.disconnect(); if (ended && !sources.size) finish(); };
      at = Math.max(at, context.currentTime + 0.02);
      source.start(at);
      at += buffer.duration;
      // Bound queued audio to ~1 second, retaining immediate stop while applying network backpressure.
      while (at - context.currentTime > 1) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        signal.throwIfAborted();
      }
    }
    ended = true;
    if (!sources.size) finish();
    await drained;
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", silence);
    silence();
    onOutput(null);
  }
}
