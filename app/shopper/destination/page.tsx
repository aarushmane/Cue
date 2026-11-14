"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { fmt } from "@/lib/review/format";
import { AISLE_NAMES } from "@/lib/seed/demo-store";
import { destinationSpeech, locKey, locText, useShopper } from "@/components/shopper/ShopperProvider";
import { sBtn } from "@/components/shopper/ShopperShell";
import { useFocusOnMount } from "@/components/shopper/useFocusOnMount";

export default function DestinationPage() {
  const s = useShopper();
  const router = useRouter();
  const h1 = useFocusOnMount<HTMLHeadingElement>();
  const [gone, setGone] = useState(false);
  const { refreshSelected } = s;

  // Re-read the published location on open, when the tab regains focus, and every 15 s, so a staff move shows up.
  useEffect(() => {
    const check = () => void refreshSelected().then((cur) => setGone(cur === null));
    check();
    const id = setInterval(check, 15000);
    const onVis = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
    // Only on mount; refreshSelected identity changes whenever the product refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const p = s.selected;
  if (!p) {
    return (
      <>
        <button type="button" onClick={() => router.push("/shopper")} className={sBtn.back}>‹ New search</button>
        <h1 ref={h1} tabIndex={-1} className={sBtn.h1}>No product chosen</h1>
        <p className="m-0 text-[1.05em]">Search for a product first.</p>
      </>
    );
  }
  const moved = s.selectedLoc !== locKey(p);
  const aisleName = AISLE_NAMES[p.shelf.aisle] ?? "";

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (s.from !== "results") s.setFocusSearch(true);
          router.push(s.from === "results" ? "/shopper/results" : "/shopper");
        }}
        className={sBtn.back}
      >
        ‹ {s.from === "results" ? "Other matches" : "New search"}
      </button>
      <h1 ref={h1} tabIndex={-1} className={sBtn.h1}>{p.name}</h1>
      <p className="m-0 text-[1.05em]">{[p.brand, p.size].filter(Boolean).join(" · ")}</p>
      {moved && !gone && (
        <div role="alert" className="rounded-[24px] border-[3px] border-(--s-warn-border) bg-(--s-warn-bg) px-[1.1em] py-[1em] text-[1.05em] text-(--s-text)">
          <strong>! Location updated by staff.</strong> The destination is now {locText(p)}.
        </div>
      )}
      {gone && (
        <div role="alert" className="rounded-[24px] border-[3px] border-(--s-warn-border) bg-(--s-warn-bg) px-[1.1em] py-[1em] text-[1.05em] text-(--s-text)">
          <strong>! This product no longer has a verified location.</strong> Ask staff for help.
        </div>
      )}
      <div className="flex flex-col gap-[0.25em] rounded-[28px] border-2 border-(--s-border) bg-(--s-surface) p-[1.15em]">
        <span className="text-[0.85em] font-extrabold tracking-[.04em] text-(--s-muted)">✓ VERIFIED DESTINATION</span>
        <span className="text-[1.5em] leading-[1.2] font-extrabold text-(--s-primary-text)">{locText(p)}</span>
        <span className="text-[0.95em]">
          {aisleName} · verified {fmt(p.location.verifiedAt)}
        </span>
      </div>
      <button
        type="button"
        onClick={() => {
          s.setSelectedLoc(locKey(p));
          s.say(destinationSpeech(p, s.prefs.detail, aisleName));
        }}
        className={`${sBtn.primary} px-4 text-[1.15em]`}
      >
        Hear location
      </button>
      <div className="rounded-[24px] border-[3px] border-dashed border-(--s-border) px-[1.1em] py-[1em] text-[1em]">
        <strong className="block text-[1.05em]">Guided scan and directions: Phase 3</strong>
        Camera location scan and step-by-step directions are not built yet. Until then, ask staff for help or hear the shelf location above.
      </div>
      <button type="button" onClick={() => s.aux("/shopper/help")} className={`${sBtn.secondary} px-4 text-[1.15em]`}>Get Help</button>
    </>
  );
}
