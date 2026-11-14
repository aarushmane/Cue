"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { brandSize, locLong, locShort, norm } from "@/lib/review/format";
import { useSnap, useStaff, withSnap } from "@/components/business/StaffProvider";
import { BackLink, controlClass, cx, PageHeader, PhotoSlot, Pill } from "@/components/business/ui";

const CHIPS = [["all", "All"], ["1", "Aisle 1"], ["2", "Aisle 2"], ["3", "Aisle 3"], ["4", "Aisle 4"]] as const;

function InventoryPage() {
  const snap = useSnap();
  const s = useStaff();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [aisle, setAisle] = useState<string>("all");
  const nq = norm(q);
  const list = snap.products.filter(
    (p) => (aisle === "all" || p.shelf.aisle === aisle) && (!nq || norm([p.name, p.brand, ...p.aliases].join(" ")).includes(nq)),
  );

  return (
    <>
      <PageHeader
        back={<BackLink onClick={() => router.push("/business/more")}>More</BackLink>}
        title="Inventory"
        sub={<span role="status">{list.length} of {snap.products.length} products</span>}
      />
      <label className="flex flex-col gap-1.5 text-[15px] font-bold">
        Search products
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, brand or alias" className={cx(controlClass, "px-5 text-[17px]")} />
      </label>
      <div role="group" aria-label="Filter by aisle" className="flex gap-2 overflow-x-auto pb-0.5">
        {CHIPS.map(([v, l]) => (
          <Pill key={v} on={aisle === v} onClick={() => setAisle(v)} className="min-h-11 flex-none px-4 text-[15px]">
            {l}
          </Pill>
        ))}
      </div>
      {!list.length && <p className="m-0 text-[15px]">No products match. Try another name, brand or aisle.</p>}
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {list.map((p) => (
          <li key={p.id} className="flex items-center gap-3 rounded-[26px] border-[1.5px] border-card bg-ivory py-2.5 pr-3.5 pl-2.5">
            <PhotoSlot label="Photo" className="size-14 rounded-full" />
            <button
              type="button"
              onClick={() => s.openProduct(p.id)}
              aria-label={`${p.name}, ${brandSize(p) || "no brand"}, ${locLong(p)}. Open details`}
              className="flex min-w-0 flex-1 flex-col gap-[3px] border-0 bg-transparent py-1 text-left text-charcoal"
            >
              <span className="text-base leading-[1.25] font-bold">{p.name}</span>
              <span className="text-sm text-muted">{brandSize(p) || "—"}</span>
              <span className="self-start rounded-full bg-lavender px-2.5 py-[3px] text-[13px] font-bold text-indigo">{locShort(p)}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export default withSnap(InventoryPage);
