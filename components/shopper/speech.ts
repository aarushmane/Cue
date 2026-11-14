"use client";
// Speech output and mic coordination for phones. Browser quirks handled here:
// - iOS Safari only lets speechSynthesis speak after a user gesture has spoken once. Agent replies arrive after a
//   network round-trip (outside any gesture), so we "unlock" speech on the first tap by speaking a silent utterance.
// - Safari can drop an utterance queued in the same tick as cancel() of one that is still playing, and can cut off
//   an utterance that is garbage-collected while playing. We keep a reference and queue after a short delay.
// - While the microphone is listening we never start speech output, so the app doesn't hear (and transcribe) itself.

let unlocked = false;
let listening = false;
let current: SpeechSynthesisUtterance | null = null; // keep the playing utterance reachable (Safari GC cut-off)

const synth = () => (typeof window !== "undefined" && "speechSynthesis" in window ? window.speechSynthesis : null);

/** Install once (idempotent). The first touchend/click/keydown speaks a silent utterance inside that gesture. */
export function installSpeechUnlock(): () => void {
  const ss = synth();
  if (unlocked || !ss) return () => {};
  const events = ["touchend", "click", "keydown"] as const;
  const unlock = () => {
    remove();
    if (unlocked) return;
    unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      ss.speak(u);
    } catch {}
  };
  const remove = () => events.forEach((e) => document.removeEventListener(e, unlock, true));
  events.forEach((e) => document.addEventListener(e, unlock, true));
  return remove;
}

export function setListening(on: boolean) {
  listening = on;
  if (on) stopSpeaking();
}
export const isListening = () => listening;

export function stopSpeaking() {
  current = null;
  try {
    synth()?.cancel();
  } catch {}
}

/** Speak `text` (replacing anything playing). Skipped while the mic is listening. */
export function speak(text: string, rate: number) {
  const ss = synth();
  if (!ss || listening || !text.trim()) return;
  try {
    const wasBusy = ss.speaking || ss.pending;
    ss.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.rate = rate;
    u.lang = "en-US"; // otherwise iOS picks the device language's voice
    u.onend = u.onerror = () => {
      if (current === u) current = null;
    };
    current = u;
    const go = () => {
      if (current === u && !listening) ss.speak(u);
    };
    // Safari drops an utterance queued in the same tick as cancelling a playing one.
    if (wasBusy) setTimeout(go, 60);
    else go();
  } catch {}
}

export type MicState = "idle" | "listening" | "processing" | "error" | "denied" | "unsupported";

/**
 * Map a SpeechRecognition error code to the screen state and message. Returns null when nothing should be shown
 * (the shopper stopped listening themselves, which some browsers report as "aborted").
 */
export function recognitionError(code: string, userStopped: boolean): { state: MicState; msg: string } | null {
  switch (code) {
    case "aborted":
      // iOS also aborts when another app takes the audio session (a call, Siri) or the page is hidden.
      return userStopped ? null : { state: "error", msg: "Listening was interrupted. Tap to try again, or type the product." };
    case "not-allowed":
      return { state: "denied", msg: "Microphone permission is off. Allow it for this site in your browser settings, or type the product." };
    case "service-not-allowed":
      // iOS: Dictation/Siri is off, or recognition was started outside a tap. Android: the speech service is blocked.
      return {
        state: "denied",
        msg: "Voice input is turned off on this device. On iPhone, turn on Dictation in Settings, General, Keyboard. Or type the product.",
      };
    case "no-speech":
      return { state: "error", msg: "I did not hear anything. Tap to try again." };
    case "audio-capture":
      return { state: "error", msg: "No microphone was found. Type the product instead." };
    case "network":
      // Chrome on Android sends audio to a server for recognition.
      return { state: "error", msg: "Voice input needs an internet connection. Check your connection, or type the product." };
    case "language-not-supported":
      return { state: "unsupported", msg: "Voice input does not support English on this device. Type the product instead." };
    default:
      return { state: "error", msg: `Voice input stopped (${code}). Tap to try again, or type.` };
  }
}
