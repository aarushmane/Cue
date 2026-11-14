"use client";
// Shopper agent conversation: the agent's reply, the current route step (verbatim planRoute text), choice buttons,
// Next / Repeat / Previous while guiding, a position scan when directions need one, and voice or typed replies.
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { isGuiding, needsPosition } from "@/components/shopper/guide";
import { PositionScan } from "@/components/shopper/PositionScan";
import { useShopper } from "@/components/shopper/ShopperProvider";
import { sBtn } from "@/components/shopper/ShopperShell";
import { useFocusOnMount } from "@/components/shopper/useFocusOnMount";
import { VoiceSurface } from "@/components/shopper/VoiceSurface";

const TITLE: Record<string, string> = {
  SEARCHING: "Assistant",
  DESTINATION_SELECTED: "Product chosen",
  LOCATING: "Find my position",
  ROUTING: "Directions",
  GUIDING: "Directions",
  ARRIVED: "You have arrived",
  NEEDS_HELP: "Getting help",
};

export default function GuidePage() {
  const s = useShopper();
  const router = useRouter();
  const h1 = useFocusOnMount<HTMLHeadingElement>();
  const input = useRef<HTMLInputElement>(null);
  const [reply, setReply] = useState("");
  const g = s.guide;
  const state = g.nav.state ?? "SEARCHING";
  const step = g.routeText.length ? g.routeText[g.routeText.length - 1] : "";
  const send = (text: string) => {
    if (!text.trim() || g.busy) return;
    setReply("");
    void s.ask(text);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => {
          s.resetGuide();
          s.setFocusSearch(true);
          router.push("/shopper");
        }}
        className={sBtn.back}
      >
        ‹ New search
      </button>
      <h1 ref={h1} tabIndex={-1} className={sBtn.h1}>{TITLE[state] ?? "Assistant"}</h1>

      {g.online === false && (
        <div role="alert" className="rounded-[24px] border-[3px] border-(--s-warn-border) bg-(--s-warn-bg) px-[1.1em] py-[1em] text-[1.05em] text-(--s-text)">
          <strong>The voice assistant is offline.</strong> You can still search by typing on the search screen.
        </div>
      )}

      {g.heard && <p className="m-0 text-[1em] text-(--s-muted)">You said: “{g.heard}”</p>}

      {step && (
        <div className="flex flex-col gap-[0.25em] rounded-[28px] border-2 border-(--s-border) bg-(--s-surface) p-[1.15em]">
          <span className="text-[0.85em] font-extrabold tracking-[.04em] text-(--s-muted)">{state === "ARRIVED" ? "ARRIVED" : "CURRENT STEP"}</span>
          <span className="text-[1.4em] leading-[1.25] font-extrabold text-(--s-primary-text)">{step}</span>
        </div>
      )}

      <div aria-busy={g.busy} className={`${sBtn.card} flex flex-col gap-[0.5em]`}>
        <span className="text-[0.85em] font-extrabold tracking-[.04em] text-(--s-muted)">ASSISTANT</span>
        <p className="m-0 text-[1.1em]">
          {g.busy ? "Thinking…" : g.agentText || g.say || "Tap below and say what you need, like “I need almond milk”."}
        </p>
        {g.error && !g.busy && (
          <p role="alert" className="m-0 text-[1em] font-semibold" style={{ color: s.t.err }}>{g.error}</p>
        )}
        {g.say && !g.busy && (
          <button type="button" onClick={() => s.say(g.say, g.nav.prefs?.speech_rate)} className={`${sBtn.secondary} min-h-12 text-[1em]`}>
            Hear again
          </button>
        )}
      </div>

      {g.choices.length > 0 && (
        <section aria-labelledby="choices-h" className="flex flex-col gap-2.5">
          <h2 id="choices-h" className="m-0 text-[1.15em] font-extrabold">Choose one</h2>
          {g.choices.map((c) => (
            <button key={c} type="button" onClick={() => send(c)} aria-disabled={g.busy || undefined} className={`${sBtn.secondary} text-left text-[1.05em]`}>
              {c}
            </button>
          ))}
        </section>
      )}

      {isGuiding(state) && (
        <div className="grid grid-cols-3 gap-2.5">
          <button type="button" onClick={() => send("previous step")} aria-disabled={g.busy || undefined} className={`${sBtn.secondary} px-2 text-[1em]`}>Previous</button>
          <button type="button" onClick={() => send("repeat")} aria-disabled={g.busy || undefined} className={`${sBtn.secondary} px-2 text-[1em]`}>Repeat</button>
          <button type="button" onClick={() => send("next step")} aria-disabled={g.busy || undefined} className={`${sBtn.primary} px-2 text-[1em]`}>Next</button>
        </div>
      )}

      {needsPosition(g.nav) && <PositionScan />}

      {g.online !== false && (
        <>
          <VoiceSurface compact disabled={g.busy} onUnsupported={() => input.current?.focus()} />
          <p id="mic-status" className="m-0 min-h-[1.4em] text-center text-[1em] font-semibold" style={{ color: s.msg.err ? s.t.err : s.t.text }}>
            {s.msg.text}
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(reply);
            }}
            className="flex flex-col gap-[0.6em]"
          >
            <label htmlFor="sg-reply" className="text-[1.05em] font-extrabold">Or type a reply</label>
            <input
              id="sg-reply"
              ref={input}
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              autoComplete="off"
              placeholder="e.g. the unsweetened one"
              className="min-h-[60px] rounded-full border-[3px] border-(--s-border) bg-(--s-surface) px-[22px] text-[1.1em] text-(--s-text)"
            />
            <button type="submit" aria-disabled={g.busy || undefined} className={`${sBtn.primary} text-[1.1em]`}>Send</button>
          </form>
        </>
      )}

      <button type="button" onClick={() => s.aux("/shopper/help")} className={`${sBtn.secondary} text-[1.05em]`}>Get Help</button>
      <p className="m-0 text-[0.9em] text-(--s-muted)">StoreGuide does not detect obstacles. Keep using your cane, guide dog or other mobility aid.</p>
    </>
  );
}
