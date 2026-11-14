import type { ReactNode } from "react";
import { Caprasimo, Figtree } from "next/font/google";
import "@/app/legacy.css";

// Caprasimo: manager headings. Figtree: everything else (shopper headings use weight 800).
const caprasimo = Caprasimo({ variable: "--font-caprasimo", weight: "400", subsets: ["latin"] });
const figtree = Figtree({ variable: "--font-figtree", subsets: ["latin"] });

/**
 * The shopper/manager apps' v4 theme. It is scoped to the route layouts that render it so the
 * 3D walkthrough at `/` keeps the shadcn design system untouched.
 */
export function LegacyTheme({ children }: { children: ReactNode }) {
  return <div className={`${caprasimo.variable} ${figtree.variable} min-h-dvh bg-lavender font-sans text-charcoal antialiased`}>{children}</div>;
}
