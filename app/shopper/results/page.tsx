"use client";
import { useRouter } from "next/navigation";
import { locText, spokenName, useShopper } from "@/components/shopper/ShopperProvider";
import { sBtn } from "@/components/shopper/ShopperShell";
import { useFocusOnMount } from "@/components/shopper/useFocusOnMount";

export default function ResultsPage() {
  const s = useShopper();
  const router = useRouter();
  const h1 = useFocusOnMount<HTMLHeadingElement>();
  const newSearch = () => {
    s.setQ("");
    s.setFocusSearch(true);
    router.push("/shopper");
  };

  return (
    <>
      <button type="button" onClick={newSearch} className={sBtn.back}>‹ New search</button>
      <h1 ref={h1} tabIndex={-1} className={sBtn.h1}>
        {s.results.length ? `${s.results.length} matches for “${s.resQuery}”` : "No search yet"}
      </h1>
      <p className="m-0 text-[1.05em]">{s.results.length ? "Choose the exact product." : "Search for a product first."}</p>
      <ul className="m-0 flex list-none flex-col gap-3.5 p-0">
        {s.results.map((p, i) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => s.select(p, "results")}
              aria-label={`Option ${i + 1}: ${spokenName(p)}${p.variant ? ", " + p.variant : ""}. Verified at ${locText(p)}.`}
              className="flex w-full flex-col gap-[0.3em] rounded-[28px] border-[3px] border-(--s-border) bg-(--s-surface) px-[1.1em] py-[1em] text-left text-(--s-text)"
            >
              <span className="text-[0.85em] font-extrabold text-(--s-muted)">Option {i + 1}</span>
              <span className="text-[1.3em] leading-[1.2] font-extrabold">{p.name}</span>
              <span className="text-[1em]">{[p.brand, p.size, p.variant].filter(Boolean).join(" · ")}</span>
              <span className="text-[1em] font-extrabold text-(--s-primary-text)">✓ Verified: {locText(p)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
