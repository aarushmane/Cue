"use client";
// Manager Home A: task-first stacked workspace.
import { useRouter } from "next/navigation";
import { Map as MapIcon, Sparkles } from "lucide-react";
import { shelfOf } from "@/lib/review/format";
import { useSnap, useStaff, withSnap } from "@/components/business/StaffProvider";
import { eventRow, pendingObs, plural, productsAt } from "@/components/business/derive";
import { Button, ICON } from "@/components/business/ui";

const AISLE_X: Record<string, number> = { "1": 0.18, "2": 0.4, "3": 0.62, "4": 0.84 };

function BusinessHome() {
  const snap = useSnap();
  const s = useStaff();
  const router = useRouter();
  const pub = snap.maps.published;
  const pending = pendingObs(snap).length;
  const recent = snap.audit.slice(0, 3).map(eventRow);
  const nodes = Object.fromEntries(pub.nodes.map((n) => [n.id, n]));
  const hs = shelfOf(s.homeShelf);
  const hn = hs ? productsAt(snap, hs.id).length : 0;
  const hasNew = snap.audit.length > 0;

  return (
    <>
      <header className="flex flex-col gap-1.5 pt-1.5">
        <div className="flex items-center gap-3">
          <p className="m-0 flex-1 text-[15px] font-semibold text-muted">{snap.storeName}</p>
          <button
            type="button"
            onClick={() => router.push("/business/activity")}
            aria-label={`Profile and activity for ${snap.staff.label}`}
            className="relative size-12 flex-none rounded-full border-0 bg-indigo text-base font-bold text-white"
          >
            DR
            {hasNew && (
              <span aria-hidden="true" className="absolute top-0 right-0 size-3.5 rounded-full border-[2.5px] border-lavender bg-gold" />
            )}
          </button>
        </div>
        <h1 className="m-0 font-display text-[32px] leading-[1.1] font-normal text-indigo">Good morning, Dana.</h1>
        <p className="m-0 text-[17px]">Here&apos;s what needs your attention today.</p>
        <p className="mt-1.5 mb-0 self-start rounded-full bg-tint px-3 py-1 text-[13px] font-semibold">
          Demo store · mock data, nothing is saved to a server
        </p>
      </header>

      <section aria-labelledby="nt-h" className="flex flex-col gap-3 rounded-[30px] border-[1.5px] border-card bg-ivory p-5">
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="flex size-9 flex-none items-center justify-center rounded-full bg-gold text-charcoal">
            <Sparkles size={18} {...ICON} />
          </span>
          <span className="text-[13px] font-bold tracking-[.06em] text-muted">YOUR NEXT TASK · PRIORITY</span>
        </div>
        <h2 id="nt-h" className="m-0 font-display text-[22px] leading-[1.2] font-normal text-charcoal">
          {pending === 1 ? "1 product is" : `${pending} products are`} waiting for review.
        </h2>
        <p className="m-0 text-[15px] text-muted">New shopper observations are ready. Nothing is published until you accept it.</p>
        <Button onClick={() => { s.setReviewId(null); s.setRTab("pending"); router.push("/business/review"); }}>Review Products</Button>
      </section>

      <section aria-labelledby="sc-h" className="flex items-start gap-4 rounded-[30px] border-[1.5px] border-card bg-ivory p-5">
        <span aria-hidden="true" className="flex size-16 flex-none items-center justify-center rounded-full bg-tint text-indigo">
          <MapIcon size={30} {...ICON} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 id="sc-h" className="m-0 font-display text-xl leading-[1.2] font-normal text-charcoal">Manage your store floor plan.</h2>
          <p className="m-0 text-[15px] text-muted">Upload your plan, then mark shelves, entrances, landmarks and walkable paths.</p>
          <Button variant="outline" className="mt-1.5 min-h-12 self-start" onClick={() => router.push("/business/floor-plan")}>
            Open Floor Plan
          </Button>
        </div>
      </section>

      <section aria-labelledby="ex-h" className="flex flex-col gap-2.5">
        <div className="flex items-baseline justify-between">
          <h2 id="ex-h" className="m-0 font-display text-[21px] font-normal text-indigo">Explore your store</h2>
          <button
            type="button"
            onClick={() => router.push("/business/floor-plan")}
            className="border-0 bg-transparent px-1 py-2.5 text-[15px] font-bold text-indigo underline underline-offset-[3px]"
          >
            View Full Map
          </button>
        </div>
        <div className="flex flex-col gap-2.5 rounded-[30px] border-[1.5px] border-card bg-ivory p-3.5">
          <div className="relative aspect-[3/2]">
            <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true" className="absolute inset-0 size-full">
              {pub.edges.map(([a, b]) =>
                nodes[a] && nodes[b] ? (
                  <line
                    key={a + b}
                    x1={nodes[a].x} y1={nodes[a].y} x2={nodes[b].x} y2={nodes[b].y}
                    stroke="#B9AED6" strokeWidth={3} strokeDasharray="1 5" strokeLinecap="round" vectorEffect="non-scaling-stroke"
                  />
                ) : null,
              )}
            </svg>
            {Object.entries(AISLE_X).map(([a, x]) => (
              <span key={a} aria-hidden="true" className="absolute top-[10%] -translate-x-1/2 text-[11px] font-bold text-muted" style={{ left: `${x * 100}%` }}>
                A{a}
              </span>
            ))}
            {pub.shelves.filter((r) => r.id).map((r) => {
              const cat = shelfOf(r.id);
              if (!cat) return null;
              const on = s.homeShelf === r.id;
              const n = productsAt(snap, r.id).length;
              return (
                <button
                  key={r.key}
                  type="button"
                  aria-pressed={on}
                  aria-label={`Aisle ${cat.aisle}, Section ${cat.section}, ${plural(n, "product")}`}
                  onClick={() => s.setHomeShelf(r.id)}
                  className="absolute rounded-lg border-2 p-0 text-[11px] font-bold"
                  style={{
                    left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%`,
                    borderColor: on ? "#E8B84B" : "#776C95", background: on ? "#44337A" : "#DCD3EC", color: on ? "#FFFFFF" : "#44337A",
                  }}
                >
                  {cat.section}
                </button>
              );
            })}
          </div>
          {hs && (
            <div role="status" className="flex items-center gap-2.5 rounded-[20px] bg-lavender px-3.5 py-2.5">
              <span className="flex-1 text-[15px]">
                <strong>Aisle {hs.aisle} · Section {hs.section}</strong> · {plural(hn, "product")}
              </span>
              <button
                type="button"
                onClick={() => { s.openShelf(hs.id); router.push("/business/floor-plan"); }}
                className="sg-primary min-h-11 rounded-full border-0 bg-indigo px-3.5 text-sm font-bold text-white"
              >
                Open
              </button>
            </div>
          )}
        </div>
      </section>

      <section aria-labelledby="rc-h" className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <h2 id="rc-h" className="m-0 font-display text-[21px] font-normal text-indigo">Recent changes</h2>
          <button
            type="button"
            onClick={() => router.push("/business/activity")}
            className="border-0 bg-transparent px-1 py-2.5 text-[15px] font-bold text-indigo underline underline-offset-[3px]"
          >
            See all
          </button>
        </div>
        <ol className="m-0 flex list-none flex-col p-0">
          {recent.map((e) => (
            <li key={e.id} className="flex items-start gap-3 border-b-[1.5px] border-card px-0.5 py-3">
              <span aria-hidden="true" className="mt-[7px] size-2.5 flex-none rounded-full" style={{ background: e.dot }} />
              <span className="min-w-0 flex-1">
                <span className="block text-[15px] leading-[1.35] font-semibold">{e.summary}</span>
                <span className="mt-0.5 block text-sm text-muted">{e.when}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}

export default withSnap(BusinessHome);
