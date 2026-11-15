"use client";

import { useEffect, useRef } from "react";
import { advanceSpring, displayLevel, rootMeanSquare, speechBands } from "@/lib/audio/analysis";

type Mode = "off" | "listening" | "thinking" | "speaking" | "stopped";

/** Radial waveform drawn around a centred control (the microphone button). */
const COUNT = 56;
const SIZE = 200;
const CENTER = SIZE / 2;
/** Bars start just outside the button and grow outward. */
const INNER = 44;
const REACH = 46;

export function AudioWave({ analyser, mode }: { analyser: AnalyserNode | null; mode: Mode }) {
  const svg = useRef<SVGSVGElement>(null);
  const meter = useRef<HTMLMeterElement>(null);
  const springs = useRef(Array.from({ length: COUNT }, () => ({ value: 0, velocity: 0 })));

  useEffect(() => {
    const bars = Array.from(svg.current!.querySelectorAll("rect"));
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const samples = new Float32Array(analyser?.fftSize ?? 2048);
    const frequencies = new Uint8Array(analyser?.frequencyBinCount ?? 1024);
    const responsive = Boolean(analyser) && mode !== "stopped" && mode !== "off";
    const half = Math.ceil(COUNT / 2);
    let frame = 0;
    let last = 0;
    const draw = (now: number) => {
      const dt = Math.min((now - (last || now)) / 1000, 0.1);
      last = now;
      if (responsive) { analyser?.getFloatTimeDomainData(samples); analyser?.getByteFrequencyData(frequencies); }
      const level = responsive ? displayLevel(rootMeanSquare(samples)) : 0;
      if (meter.current) meter.current.value = level;
      // Mirror the speech bands left/right so the ring is symmetric, low frequencies at the top.
      const bands = speechBands(frequencies, analyser?.context.sampleRate ?? 48000, samples.length, half);
      let settling = false;
      springs.current = springs.current.map((spring, index) => {
        const band = bands[Math.min(index, COUNT - index) % half] ?? 0;
        const target = level * (0.2 + band * 0.8);
        const next = advanceSpring(spring, target, dt);
        settling ||= Math.abs(next.value) > 0.001 || Math.abs(next.velocity) > 0.001;
        const baseline = mode === "stopped" ? 1.5 : 3;
        const height = motion.matches ? baseline : baseline + Math.max(0, Math.min(1, next.value)) * REACH;
        bars[index].setAttribute("height", height.toFixed(2));
        bars[index].setAttribute("y", (CENTER - INNER - height).toFixed(2));
        return next;
      });
      if (responsive || settling) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser, mode]);

  return (
    <div className="voice-wave" data-active={Boolean(analyser)} data-mode={mode}>
      <svg ref={svg} viewBox={`0 0 ${SIZE} ${SIZE}`} fill="none" aria-hidden="true">
        {Array.from({ length: COUNT }, (_, index) => (
          <rect key={index} x={CENTER - 1.5} y={CENTER - INNER - 3} width="3" height="3" rx="1.5"
            transform={`rotate(${(index * 360) / COUNT} ${CENTER} ${CENTER})`} />
        ))}
      </svg>
      <meter ref={meter} className="voice-level" min="0" max="1" value="0" aria-label="Microphone sound level" />
    </div>
  );
}
