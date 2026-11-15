/** Digital signal energy, not a calibrated measurement of sound pressure. */
export function rootMeanSquare(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

/** Gate quiet background noise and compress the display range for normal speech. */
export function displayLevel(rms: number): number {
  return Math.min(1, Math.max(0, (rms - 0.005) / 0.12)) ** 0.55;
}

/** Logarithmic bands across 80–8000 Hz. Each bar represents measured frequency energy. */
export function speechBands(bins: Uint8Array, sampleRate: number, fftSize: number, count: number): number[] {
  const upper = Math.min(8000, sampleRate / 2);
  const hzPerBin = sampleRate / fftSize;
  return Array.from({ length: count }, (_, index) => {
    const low = Math.max(1, Math.floor((80 * (upper / 80) ** (index / count)) / hzPerBin));
    const high = Math.min(bins.length, Math.max(low + 1, Math.ceil((80 * (upper / 80) ** ((index + 1) / count)) / hzPerBin)));
    let sum = 0;
    for (let bin = low; bin < high; bin++) sum += (bins[bin] / 255) ** 2;
    return high > low ? Math.sqrt(sum / (high - low)) : 0;
  });
}

export type Spring = { value: number; velocity: number };

/** Exact critically damped spring: x'' + 2ωx' + ω²(x − target) = 0, with mass 1. */
export function advanceSpring(spring: Spring, target: number, dt: number, omega = 18): Spring {
  const elapsed = Math.max(0, dt);
  const offset = spring.value - target;
  const carry = spring.velocity + omega * offset;
  const decay = Math.exp(-omega * elapsed);
  return {
    value: target + (offset + carry * elapsed) * decay,
    velocity: (spring.velocity - omega * carry * elapsed) * decay,
  };
}
