/* Same-origin AudioWorklet: PCM16 at the AudioContext's 16 kHz rate, 100 ms packets. */
class VoiceInput extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Int16Array(1600);
    this.at = 0;
    this.energy = 0;
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (const sample of channel) {
      const value = Math.max(-1, Math.min(1, sample));
      this.samples[this.at++] = value < 0 ? value * 32768 : value * 32767;
      this.energy += value * value;
      if (this.at === this.samples.length) {
        this.port.postMessage({ pcm: this.samples.buffer, rms: Math.sqrt(this.energy / this.at) }, [this.samples.buffer]);
        this.samples = new Int16Array(1600);
        this.at = 0;
        this.energy = 0;
      }
    }
    return true; // Output remains silent; microphone audio is never monitored through speakers.
  }
}
registerProcessor("voice-input", VoiceInput);
