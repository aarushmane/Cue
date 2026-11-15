# Microphone visualizer

Press the microphone button to request audio input. The browser asks for permission; the application does not start capture automatically. The waveform is analysed locally. The active voice session streams PCM to ElevenLabs for transcription, sends text to the scene agent, and plays ElevenLabs speech. The application does not save microphone recordings. See [voice integration](voice.md) for the service boundary and cancellation behavior.

## Signal and motion

1. Web Audio exposes 2048 signed time-domain samples, typically between -1 and 1.
2. RMS amplitude is `sqrt(sum(sample²) / sample_count)`. Squaring prevents positive and negative pressure samples from cancelling out. This is a digital signal level, not calibrated sound pressure.
3. A small noise gate suppresses quiet background noise. A compressed display curve makes ordinary speech visibly responsive without clipping immediately.
4. The analyser's FFT gives frequency energy. The 41 bars cover logarithmic bands between 80 Hz and 8 kHz, modulated by the overall RMS level. They respond to microphone sound, including non-speech sounds; they do not identify words or speakers.
5. Each bar follows its measured target using a critically damped spring:

   `x'' + 36 x' + 324 (x - target) = 0`

   Here mass is 1, stiffness is 324, and damping is 36. This follows changes quickly and settles without a decorative bounce. The exact time-step solution makes it consistent at different frame rates.

Silence brings the bars back to their baseline. Reduced-motion mode replaces moving bars with a simple input-level meter. Off, permission-pending, listening, and error states are separate accessible statuses.

Ending the session, unmounting, hiding the page, and microphone disconnection release the stream tracks and audio context. Microphone input is never monitored through the speakers. The agent response is played through a separate output analyser, which drives the waveform while speaking. Stop speech and movement interrupts the current turn while leaving the microphone connected.

## Verification

For a manual check, enable the microphone, speak at different levels, and confirm the bars settle during silence. Disabling the microphone should release its browser indicator. Automated tests were removed at the user's request.

References: [MDN analyser time-domain data](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getFloatTimeDomainData), [frequency data](https://developer.mozilla.org/en-US/docs/Web/API/AnalyserNode/getByteFrequencyData), and [microphone access](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia).
