"use client";
// Shopper search home (Home A: centered voice surface).
import { useEffect, useRef } from "react";
import { locationText } from "@/components/shopper/guide";
import { useShopper } from "@/components/shopper/ShopperProvider";
import { sBtn } from "@/components/shopper/ShopperShell";
import { VoiceSurface } from "@/components/shopper/VoiceSurface";

const INSTRUCTIONS =
  "To search, tap Speak and say a product, or type it in the search field and press Search. Get Help is below the search. Your position in the store is unknown until a location scan.";

export default function ShopperHome() {
  const s = useShopper();
  const input = useRef<HTMLInputElement>(null);
  const { focusSearch, setFocusSearch, runSearch, setQ } = s;

  useEffect(() => {
    if (focusSearch) {
      input.current?.focus();
      setFocusSearch(false);
    }
  }, [focusSearch, setFocusSearch]);

  // "Find it in shopper search" from the staff Review screen links here with ?q=.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("q");
    if (!q) return;
    window.history.replaceState(null, "", "/shopper");
    setQ(q);
    void runSearch(q);
  }, [runSearch, setQ]);

  return (
    <>
      <p className="m-0 flex items-center gap-2 self-start rounded-full border-2 border-(--s-border) bg-(--s-surface) py-1.5 pr-3.5 pl-2 text-[0.9em] font-bold">
        <span aria-hidden="true" className="flex size-[26px] items-center justify-center rounded-full border-2 border-dashed border-(--s-text) text-[0.85em]">
          ?
        </span>
        Your location: {locationText(s.guide.nav) ?? "Unknown"}
      </p>
      <div className="flex flex-col gap-[0.35em]">
        <h1 className="m-0 text-[2em] leading-[1.12] font-extrabold text-(--s-primary-text)">What can I help you find?</h1>
        <p className="m-0 text-[1.05em]">Search for a product using your voice or keyboard.</p>
      </div>
      <VoiceSurface onUnsupported={() => input.current?.focus()} />
      <p id="mic-status" className="m-0 min-h-[1.4em] text-center text-[1em] font-semibold" style={{ color: s.msg.err ? s.t.err : s.t.text }}>
        {s.msg.text}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void s.runSearch(s.q);
        }}
        className="flex flex-col gap-[0.6em]"
      >
        <label htmlFor="sg-qa" className="text-[1.05em] font-extrabold">Type a product</label>
        <input
          id="sg-qa"
          ref={input}
          type="search"
          value={s.q}
          onChange={(e) => s.setQ(e.target.value)}
          autoComplete="off"
          placeholder="e.g. unsweetened almond milk"
          className="min-h-[60px] rounded-full border-[3px] border-(--s-border) bg-(--s-surface) px-[22px] text-[1.1em] text-(--s-text)"
        />
        <button type="submit" className={`${sBtn.primary} px-4 text-[1.15em]`}>Search</button>
      </form>
      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={() => {
            s.setMsg(INSTRUCTIONS);
            s.say(INSTRUCTIONS);
          }}
          className={`${sBtn.secondary} px-2.5 text-[1em]`}
        >
          Hear Instructions
        </button>
        <button type="button" onClick={() => s.aux("/shopper/help")} className={`${sBtn.secondary} px-2.5 text-[1em]`}>
          Get Help
        </button>
      </div>
      <button
        type="button"
        onClick={() => s.aux(s.prefs.contributions === "allowed" ? "/shopper/contribute" : "/shopper/consent")}
        className={`${sBtn.secondary} px-4 text-[1em]`}
      >
        Help map this store
      </button>
      <p className="m-0 text-[0.9em] text-(--s-muted)">Prototype for indoor guidance. It does not replace your cane, guide dog or other mobility aid.</p>
    </>
  );
}
