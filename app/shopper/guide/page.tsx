"use client";
// Shopper agent conversation: the agent's reply, the current route step (verbatim planRoute text), choice buttons,
// Next / Repeat / Previous while guiding, a position scan when directions need one, and voice or typed replies.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { helpDeskText, isGuiding, locationText, needsPosition } from "@/components/shopper/guide";
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
  ARRIVED: "Directions", // the panel below says "You have arrived"
  NEEDS_HELP: "Getting help",
};

// Last reply that received focus. Module scope so it survives leaving and re-opening this screen in the same tab:
// a reply is focused (and so read by screen readers) once, not again every time the screen mounts. The timestamp
// lets an immediate re-mount (React StrictMode runs effects twice in development) focus the same reply again.
const focused = { id: 0, at: 0 };
const REMOUNT_MS = 1000;

export default function GuidePage() {
  const s = useShopper();
  const router = useRouter();
  const h1 = useFocusOnMount<HTMLHeadingElement>();
  const input = useRef<HTMLInputElement>(null);
  const replyBox = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState("");
  const g = s.guide;

  // New reply → move focus to it. Replies that land here are NOT put in the live region (sendTurn announce: false),
  // so moving focus is the single announcement: the screen reader reads the step and reply once. This runs after
  // useFocusOnMount, so when the screen opens with a fresh reply, the reply (not the title) gets focus.
  useEffect(() => {
    if (g.busy || !g.replyId) return;
    const fresh = g.replyId > focused.id || (g.replyId === focused.id && Date.now() - focused.at < REMOUNT_MS);
    if (!fresh) return;
    if (g.replyId > focused.id) Object.assign(focused, { id: g.replyId, at: Date.now() });
    replyBox.current?.focus();
  }, [g.replyId, g.busy]);
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

      {/* Focus target for new replies: plain text only (no buttons inside), so focusing it reads just the step and reply. */}
      <div ref={replyBox} tabIndex={-1} aria-busy={g.busy} className="flex flex-col gap-[0.75em] rounded-[28px] outline-offset-4">
        {step && (
          <div className="flex flex-col gap-[0.25em] rounded-[28px] border-2 border-(--s-border) bg-(--s-surface) p-[1.15em]">
            <span className="text-[0.85em] font-extrabold tracking-[.04em] text-(--s-muted)">{state === "ARRIVED" ? "LAST STEP" : "CURRENT STEP"}</span>
            <span className="text-[1.4em] leading-[1.25] font-extrabold text-(--s-primary-text)">{step}</span>
          </div>
        )}
        <div className={`${sBtn.card} flex flex-col gap-[0.5em]`}>
          <span className="text-[0.85em] font-extrabold tracking-[.04em] text-(--s-muted)">ASSISTANT</span>
          <p className="m-0 text-[1.1em]">
            {g.busy ? "Thinking…" : g.agentText || g.say || "Tap below and say what you need, like “I need almond milk”."}
          </p>
          {g.error && !g.busy && (
            // Not role="alert": sendTurn already announces the error through say() (live region + speech).
            <p className="m-0 text-[1em] font-semibold" style={{ color: s.t.err }}>{g.error}</p>
          )}
        </div>
      </div>
      {g.say && !g.busy && (
        <button type="button" onClick={() => s.say(g.say, g.nav.prefs?.speech_rate)} className={`${sBtn.secondary} text-[1em]`}>
          Hear again
        </button>
      )}

      {state === "ARRIVED" && (
        <section aria-labelledby="arrived-h" className="flex flex-col gap-[0.7em] rounded-[28px] border-[3px] border-(--s-primary) bg-(--s-surface) p-[1.15em]">
          <h2 id="arrived-h" className="m-0 text-[1.5em] leading-[1.2] font-extrabold text-(--s-primary-text)">You have arrived</h2>
          <p className="m-0 text-[1.05em]">The product should be on the shelf in front of you. If it isn&apos;t there, report it and staff will check.</p>
          <button
            type="button"
            onClick={() => {
              s.resetGuide();
              s.setFocusSearch(true);
              router.push("/shopper");
            }}
            className={`${sBtn.primary} text-[1.1em]`}
          >
            Find something else
          </button>
          <button type="button" onClick={() => send("report a problem with this product")} aria-disabled={g.busy || undefined} className={`${sBtn.secondary} text-[1.05em]`}>
            Report a problem
          </button>
        </section>
      )}

      {state === "NEEDS_HELP" && (
        <section aria-labelledby="help-h" className="flex flex-col gap-[0.7em] rounded-[28px] border-[3px] border-(--s-warn-border) bg-(--s-warn-bg) p-[1.15em] text-(--s-text)">
          <h2 id="help-h" className="m-0 text-[1.4em] leading-[1.2] font-extrabold">Help desk</h2>
          <p className="m-0 text-[1.05em]">{helpDeskText()}</p>
          {locationText(g.nav) && <p className="m-0 text-[1.05em]">You are {locationText(g.nav)}.</p>}
          <p className="m-0 text-[1em]">Any staff member can also help you.</p>
          <button type="button" onClick={() => s.aux("/shopper/help")} className={`${sBtn.primary} text-[1.1em]`}>Get Help</button>
        </section>
      )}

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

      {state !== "NEEDS_HELP" && (
        <button type="button" onClick={() => s.aux("/shopper/help")} className={`${sBtn.secondary} text-[1.05em]`}>Get Help</button>
      )}
      <p className="m-0 text-[0.9em] text-(--s-muted)">StoreGuide does not detect obstacles. Keep using your cane, guide dog or other mobility aid.</p>
    </>
  );
}
