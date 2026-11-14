"use client";
// Manager shell: phone-width column, scrollable main, bottom nav (Home | Floor Plan | Review | More), toast
// and a host for bottom sheets so they cover the whole column, not just the scrolled content.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { House, Map as MapIcon, Menu, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { ProductSheet } from "./ProductSheet";
import { ShelfSheet } from "./ShelfSheet";
import { StaffProvider, useStaff } from "./StaffProvider";
import { NotStaffNotice, SessionBar, useStaffSession } from "./StaffSession";
import { cx, ICON } from "./ui";
import { SIGN_IN_PATH } from "@/lib/auth/config";

const NAV = [
  { href: "/business", label: "Home", Icon: House, match: (p: string) => p === "/business" },
  { href: "/business/floor-plan", label: "Floor Plan", Icon: MapIcon, match: (p: string) => p.startsWith("/business/floor-plan") },
  { href: "/business/review", label: "Review", Icon: Sparkles, match: (p: string) => p.startsWith("/business/review") },
  {
    href: "/business/more", label: "More", Icon: Menu,
    // Inventory, Activity and Shopper sightings live under More and highlight More.
    match: (p: string) => ["/business/more", "/business/inventory", "/business/activity", "/business/sightings", "/business/onboard"].some((x) => p.startsWith(x)),
  },
];

function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const s = useStaff();
  const { setSheetHost, toastMsg, snap, shelfSheet, productSheet } = s;
  const session = useStaffSession();
  const notStaff = session.mode === "supabase" && session.staff === false;

  return (
    <div className="relative mx-auto flex h-dvh w-full max-w-[430px] flex-col overflow-hidden bg-lavender text-charcoal">
      <div aria-hidden="true" className="h-[max(16px,env(safe-area-inset-top))] flex-none" />
      {session.mode === "supabase" ? <SessionBar email={session.email} /> : null}
      <main className="flex flex-1 flex-col gap-[22px] overflow-x-hidden overflow-y-auto px-5 pt-1 pb-7">
        {notStaff ? <NotStaffNotice email={session.email} /> : children}
      </main>

      <nav
        aria-label="Manager"
        className="grid flex-none grid-cols-4 gap-1 rounded-t-[26px] border-t-[1.5px] border-card bg-ivory px-2.5 pt-2 pb-[max(26px,env(safe-area-inset-bottom))]"
      >
        {NAV.map(({ href, label, Icon, match }) => {
          const on = match(path);
          return (
            <Link
              key={href}
              href={href}
              aria-current={on ? "page" : undefined}
              onClick={() => {
                s.openShelf(null);
                s.openProduct(null);
                if (href === "/business/review") s.setReviewId(null);
              }}
              className={cx(
                "flex min-h-14 flex-col items-center gap-1 text-[13px] no-underline",
                on ? "font-extrabold text-indigo" : "font-semibold text-charcoal",
              )}
            >
              <span className={cx("flex h-8 w-14 items-center justify-center rounded-full", on && "bg-tint")}>
                <Icon size={22} {...ICON} />
              </span>
              {label}
            </Link>
          );
        })}
      </nav>

      <div ref={setSheetHost} />
      {snap && shelfSheet ? <ShelfSheet /> : null}
      {snap && productSheet ? <ProductSheet key={productSheet} /> : null}

      {/* Always mounted so screen readers announce each new message. */}
      <div
        role="status"
        aria-live="polite"
        className={
          toastMsg
            ? "absolute inset-x-4 bottom-[104px] z-[60] rounded-[22px] bg-charcoal px-[18px] py-3.5 text-[15px] leading-[1.4] font-semibold text-white shadow-[0_12px_32px_rgba(37,35,49,.3)]"
            : "sr-only-live"
        }
      >
        {toastMsg}
      </div>
    </div>
  );
}

export function BusinessShell({ children }: { children: ReactNode }) {
  // The sign-in page is under /business but is not part of the manager app: no nav, no staff data.
  if (usePathname() === SIGN_IN_PATH) return <>{children}</>;
  return (
    <StaffProvider>
      <Shell>{children}</Shell>
    </StaffProvider>
  );
}
