"use client";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { regionOf } from "@/lib/map/graph";
import { brandSize, candLoc, fmt, shelfOf, SRC, titleOf } from "@/lib/review/format";
import { AISLE_NAMES } from "@/lib/seed/demo-store";
import { useSnap, useStaff } from "./StaffProvider";
import { pendingAt, plural, productsAt } from "./derive";
import { Button, ICON, Sheet } from "./ui";

export function ShelfSheet() {
  const snap = useSnap();
  const s = useStaff();
  const router = useRouter();
  const sh = shelfOf(s.shelfSheet);
  if (!sh) return null;
  const close = () => s.openShelf(null);
  const ps = productsAt(snap, sh.id);
  const pend = pendingAt(snap, sh.id);
  const r = regionOf(snap.maps.published, sh.id);
  const last = ps.map((p) => p.location.verifiedAt).sort().pop();

  const openReview = (id: string | null) => {
    s.openShelf(null);
    s.setRTab("pending");
    s.setReviewId(id);
    router.push("/business/review");
  };

  return (
    <Sheet labelledBy="shelf-sheet-h" onClose={close} maxH="78%">
      <div className="flex items-start gap-2.5">
        <div className="flex-1">
          <h2 id="shelf-sheet-h" className="m-0 font-display text-2xl font-normal text-indigo">
            Aisle {sh.aisle} · Section {sh.section}
          </h2>
          <p className="mt-0.5 mb-0 text-[15px] text-muted">
            {sh.id} · {AISLE_NAMES[sh.aisle]} · approach {r?.anchor || "not set"}
          </p>
        </div>
        <button type="button" onClick={close} aria-label="Close shelf details" className="flex size-11 flex-none items-center justify-center rounded-full border-0 bg-lavender text-charcoal">
          <X size={20} {...ICON} />
        </button>
      </div>
      <h3 className="m-0 text-[15px] font-bold">✓ {plural(ps.length, "verified product")}</h3>
      <p className="-mt-2 mb-0 text-sm text-muted">{last ? `Last verified ${fmt(last)}` : "No verified products yet"}</p>
      {ps.map((p) => (
        <button
          key={p.id}
          type="button"
          onClick={() => s.openProduct(p.id)}
          className="flex min-h-14 items-center justify-between gap-2.5 rounded-[20px] border-0 bg-lavender px-4 py-3 text-left text-charcoal"
        >
          <span>
            <span className="block text-base font-bold">{p.name}</span>
            <span className="block text-sm text-muted">
              {p.category || "Uncategorized"} · {brandSize(p) || "No brand"}
            </span>
          </span>
          <span className="flex-none text-right text-[13px] font-bold text-indigo">
            <span className="block">✓ Verified</span>
            <span className="block capitalize">{p.location.level}</span>
          </span>
        </button>
      ))}
      {pend.length > 0 && (
        <>
          <h3 className="mt-1 mb-0 text-[15px] font-bold">◌ {plural(pend.length, "pending observation")} · not published</h3>
          {pend.map((o) => (
            <button
              key={o.id}
              type="button"
              onClick={() => openReview(o.id)}
              className="flex min-h-14 items-center justify-between gap-2.5 rounded-[20px] border-2 border-dashed border-control bg-ivory px-4 py-3 text-left text-charcoal"
            >
              <span>
                <span className="block text-base font-bold">{titleOf(o.candidate)}</span>
                <span className="block text-sm text-muted">
                  {o.id} · {SRC[o.source]} · {candLoc(o.candidate)}
                </span>
              </span>
              <span className="flex-none rounded-full bg-gold px-2.5 py-[3px] text-xs font-bold text-charcoal">Pending</span>
            </button>
          ))}
        </>
      )}
      <Button className="min-h-14 text-[17px]" onClick={() => openReview(pend.length === 1 ? pend[0].id : null)}>
        {pend.length ? `Review ${pend.length} pending discover${pend.length === 1 ? "y" : "ies"}` : "Open review queue"}
      </Button>
    </Sheet>
  );
}
