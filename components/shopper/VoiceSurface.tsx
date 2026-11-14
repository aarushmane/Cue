"use client";
// Voice surface: a single full-width <button> (no other controls inside). Recording only starts on a tap,
// announces "Listening." and 'Heard "…".', then asks the shopper agent (plain search when the agent is offline). States: idle, listening, processing,
// error, denied, unsupported. The status line below is referenced by aria-describedby.
import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { useShopper } from "./ShopperProvider";

type MicState = "idle" | "listening" | "processing" | "error" | "denied" | "unsupported";

const MIC: Record<MicState, { label: string; sub: string; aria: string }> = {
  idle: { label: "Tap anywhere here to speak", sub: "Voice search. You can also type below.", aria: "Tap anywhere here to speak. Starts voice search" },
  listening: { label: "Listening…", sub: "Tap anywhere here to stop", aria: "Listening. Tap to stop" },
  processing: { label: "Processing…", sub: "Finding what you said", aria: "Processing speech" },
  error: { label: "Tap anywhere here to try again", sub: "Or type the product below", aria: "Voice input error. Tap to try again, or type below" },
  denied: { label: "Microphone blocked", sub: "Tap for details, or type below", aria: "Microphone permission denied. Tap for details, or use the text field below" },
  unsupported: { label: "Voice not available", sub: "Type the product below", aria: "Voice input not available in this browser. Use the text field below" },
};

// Minimal Web Speech API surface (not in TypeScript's DOM lib).
interface Rec {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onspeechend: (() => void) | null;
  onresult: ((e: { results: { 0: { 0: { transcript: string } } } }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecCtor = new () => Rec;

export function VoiceSurface({ onUnsupported, compact = false, disabled = false }: { onUnsupported: () => void; compact?: boolean; disabled?: boolean }) {
  const { t, setMsg, setQ, ask } = useShopper();
  const [state, setState] = useState<MicState>("idle");
  const rec = useRef<Rec | null>(null);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  useEffect(() => () => rec.current?.abort(), []);

  const toggle = () => {
    if (state === "listening") {
      try {
        rec.current?.stop();
      } catch {}
      setState("idle");
      setMsg("Stopped listening.");
      return;
    }
    if (state === "processing" || disabled) return;
    const w = window as unknown as { SpeechRecognition?: RecCtor; webkitSpeechRecognition?: RecCtor };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) {
      setState("unsupported");
      setMsg("Voice input is not available in this browser. Type the product instead.", true);
      onUnsupported();
      return;
    }
    try {
      window.speechSynthesis?.cancel();
    } catch {}
    const r = new SR();
    rec.current = r;
    r.lang = "en-US";
    r.interimResults = false;
    r.maxAlternatives = 1;
    let got = false;
    r.onspeechend = () => {
      if (stateRef.current === "listening") {
        setState("processing");
        setMsg("Processing what you said…");
      }
    };
    r.onresult = (e) => {
      got = true;
      const text = e.results[0][0].transcript;
      setQ(text);
      setState("idle");
      setMsg(`Heard “${text}”.`);
      void ask(text);
    };
    r.onerror = (e) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        setState("denied");
        setMsg("Microphone permission is off. Allow it in your browser settings, or type the product.", true);
      } else if (e.error === "no-speech") {
        setState("error");
        setMsg("I did not hear anything. Tap to try again.", true);
      } else {
        setState("error");
        setMsg(`Voice input stopped (${e.error}). Tap to try again, or type.`, true);
      }
    };
    r.onend = () => {
      if (!got && (stateRef.current === "listening" || stateRef.current === "processing")) setState("idle");
    };
    try {
      r.start();
      setState("listening");
      setMsg("Listening.");
    } catch {
      setState("error");
      setMsg("Could not start the microphone. Type the product instead.", true);
    }
  };

  const m = MIC[state];
  const active = state === "listening" || state === "processing";
  const bad = state === "error" || state === "denied" || state === "unsupported";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={state === "listening"}
      aria-label={m.aria}
      aria-describedby="mic-status"
      aria-disabled={disabled || undefined}
      className={`flex ${compact ? "min-h-[180px]" : "min-h-[340px]"} w-full flex-col items-center justify-center gap-4 rounded-[40px] border-4 px-5 py-7`}
      style={{
        background: active ? t.text : bad ? t.surface : t.primary,
        color: active ? t.bg : bad ? t.text : t.onPrimary,
        borderColor: bad ? t.err : active ? t.text : t.primary,
        boxShadow: `0 0 0 ${active ? 14 : 0}px ${t.tint}`,
      }}
    >
      <span aria-hidden="true" className="flex size-[104px] items-center justify-center rounded-full border-[3px] border-current">
        <Mic size={56} strokeWidth={2.75} />
      </span>
      <span className="max-w-[9em] text-center text-[1.5em] leading-[1.2] font-extrabold">{m.label}</span>
      <span className="text-center text-[0.95em] font-semibold">{m.sub}</span>
    </button>
  );
}
