"use client";
// Shopper shell: theme background, content root font-size 17px × scale (every size below is in em, never CSS zoom),
// visually hidden polite live region, header with the settings button.
import { usePathname } from "next/navigation";
import { SlidersVertical } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { DEMO_STORE } from "@/lib/seed/demo-store";
import { ShopperProvider, useShopper } from "./ShopperProvider";

const STEP: Record<string, string> = {
  "/shopper": "Step 1 of 5 · Search",
  "/shopper/results": "Step 2 of 5 · Choose product",
  "/shopper/destination": "Step 2 of 5 · Destination",
  "/shopper/help": "Help",
  "/shopper/settings": "Preferences",
  "/shopper/consent": "Product contributions",
  "/shopper/contribute": "Help map this store",
};

function Shell({ children }: { children: ReactNode }) {
  const { t, prefs, live, aux } = useShopper();
  const path = usePathname();
  const vars = {
    "--s-bg": t.bg, "--s-surface": t.surface, "--s-text": t.text, "--s-muted": t.muted, "--s-primary": t.primary,
    "--s-primary-text": t.primaryText, "--s-on-primary": t.onPrimary, "--s-border": t.border, "--s-tint": t.tint,
    "--s-warn-bg": t.warnBg, "--s-warn-border": t.warnBorder, "--s-err": t.err,
    background: t.bg, color: t.text,
  } as CSSProperties;

  return (
    <div style={vars} className="min-h-dvh w-full">
      <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col">
        <div aria-hidden="true" className="h-[max(16px,env(safe-area-inset-top))] flex-none" />
        <p role="status" aria-live="polite" className="sr-only-live">{live}</p>
        <main className="flex-1 overflow-x-hidden">
          <div style={{ fontSize: Math.round(17 * prefs.scale) }} className="flex flex-col gap-[1.15em] px-5 pt-1 pb-7 leading-[1.45]">
            <header className="flex items-start gap-2.5">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[0.85em] font-extrabold tracking-[.08em] text-(--s-primary-text)">STOREGUIDE</span>
                <span className="text-[1em] font-bold">{DEMO_STORE.name}</span>
                <span className="text-[0.85em] text-(--s-muted)">{STEP[path] ?? ""}</span>
              </div>
              <button
                type="button"
                onClick={() => aux("/shopper/settings")}
                aria-label="Accessibility and privacy settings"
                className="flex size-14 flex-none items-center justify-center rounded-full border-2 border-(--s-border) bg-(--s-surface) text-(--s-text)"
              >
                <SlidersVertical size={24} strokeWidth={2.75} aria-hidden="true" />
              </button>
            </header>
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

export function ShopperShell({ children }: { children: ReactNode }) {
  return (
    <ShopperProvider>
      <Shell>{children}</Shell>
    </ShopperProvider>
  );
}

/** Shared shopper styles (sizes in em so they scale with Text size). Buttons set their own text size. */
export const sBtn = {
  primary: "min-h-[60px] rounded-full border-0 bg-(--s-primary) px-4 font-extrabold text-(--s-on-primary)",
  secondary: "min-h-[60px] rounded-full border-[3px] border-(--s-text) bg-(--s-surface) px-4 font-extrabold text-(--s-text)",
  back: "min-h-12 self-start border-0 bg-transparent p-0 text-[1.05em] font-extrabold text-(--s-primary-text)",
  h1: "m-0 text-[1.75em] leading-[1.15] font-extrabold text-(--s-primary-text)",
  card: "rounded-[24px] border-2 border-(--s-border) bg-(--s-surface) px-[1.1em] py-[1em]",
};
