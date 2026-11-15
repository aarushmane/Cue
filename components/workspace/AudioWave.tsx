"use client";

import { useEffect, useRef } from "react";
import { advanceSpring, displayLevel, rootMeanSquare, speechBands } from "@/lib/audio/analysis";

const COUNT = 41;

export function AudioWave({ analyser, mode }: { analyser: AnalyserNode | null; mode: "off" | "listening" | "thinking" | "speaking" | "stopped" }) {
  const svg = useRef<SVGSVGElement>(null);
  const meter = useRef<HTMLMeterElement>(null);
  const springs = useRef(Array.from({ length: COUNT }, () => ({ value: 0, velocity: 0 })));

  useEffect(() => {
    const bars = Array.from(svg.current!.querySelectorAll("rect"));
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const samples = new Float32Array(analyser?.fftSize ?? 2048);
    const frequencies = new Uint8Array(analyser?.frequencyBinCount ?? 1024);
    const responsive = Boolean(analyser) && mode !== "stopped" && mode !== "off";
    let frame = 0;
    let last = 0;
    const draw = (now: number) => {
      const dt = Math.min((now - (last || now)) / 1000, 0.1);
      last = now;
      if (responsive) { analyser?.getFloatTimeDomainData(samples); analyser?.getByteFrequencyData(frequencies); }
      const level = responsive ? displayLevel(rootMeanSquare(samples)) : 0;
      if (meter.current) meter.current.value = level;
      const bands = speechBands(frequencies, analyser?.context.sampleRate ?? 48000, samples.length, COUNT);
      let settling = false;
      springs.current = springs.current.map((spring, index) => {
        const target = level * (0.2 + bands[index] * 0.8);
        const next = advanceSpring(spring, target, dt);
        settling ||= Math.abs(next.value) > 0.001 || Math.abs(next.velocity) > 0.001;
        const baseline = mode === "stopped" ? 1.5 : 3;
        const height = motion.matches ? baseline : baseline + Math.max(0, Math.min(1, next.value)) * 94;
        bars[index].setAttribute("height", height.toFixed(2));
        bars[index].setAttribute("width", mode === "stopped" ? "7" : "3");
        bars[index].setAttribute("y", ((120 - height) / 2).toFixed(2));
        return next;
      });
      if (responsive || settling) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [analyser, mode]);

  return (
    <div className="voice-wave" data-active={Boolean(analyser)} data-mode={mode}>
      <svg ref={svg} viewBox="0 0 285 120" fill="none" aria-hidden="true">
        {Array.from({ length: COUNT }, (_, index) => <rect key={index} x={index * 7} y="58.5" width="3" height="3" rx="1.5" />)}
      </svg>
      <meter ref={meter} className="voice-level" min="0" max="1" value="0" aria-label="Microphone sound level" />
    </div>
  );
}
