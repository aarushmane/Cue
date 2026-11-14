"use client";
import Link from "next/link";
import { Building2, Camera, ChevronRight, History, Package } from "lucide-react";
import { useSnap, useStaff, withSnap } from "@/components/business/StaffProvider";
import { Button, CheckRow, ICON, PageHeader } from "@/components/business/ui";

function MorePage() {
  const snap = useSnap();
  const s = useStaff();
  const items = [
    { href: "/business/inventory", label: "Inventory", sub: `${snap.products.length} products · move and publish`, Icon: Package },
    { href: "/business/activity", label: "Activity", sub: `${snap.audit.length} events`, Icon: History },
    { href: "/business/onboard", label: "Onboard a store", sub: "Import a CoStar digital twin as a draft map", Icon: Building2 },
    { href: "/business/sightings", label: "Shopper sightings", sub: "Changes suggested by shopper camera scans", Icon: Camera },
  ];
  return (
    <>
      <PageHeader title="More" />
      <nav aria-label="More sections" className="flex flex-col gap-2.5">
        {items.map(({ href, label, sub, Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex min-h-[72px] items-center gap-3.5 rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-3.5 text-charcoal no-underline"
          >
            <span aria-hidden="true" className="flex size-11 flex-none items-center justify-center rounded-full bg-tint text-indigo">
              <Icon size={22} {...ICON} />
            </span>
            <span className="flex-1">
              <span className="block text-[17px] font-bold">{label}</span>
              <span className="block text-sm text-muted">{sub}</span>
            </span>
            <ChevronRight size={20} color="#44337A" {...ICON} />
          </Link>
        ))}
      </nav>

      <section aria-labelledby="demo-h" className="flex flex-col gap-2.5 rounded-[26px] border-2 border-dashed border-control p-[18px]">
        <h2 id="demo-h" className="m-0 text-base font-bold">Demo controls (prototype only)</h2>
        <p className="m-0 text-sm text-muted">These exist only to demonstrate the review workflow. They are not part of the product.</p>
        <CheckRow checked={s.simulateFailure} onChange={s.setSimulateFailure}>
          Simulate a publishing failure on the next approval
        </CheckRow>
        <Button variant="dark" className="min-h-12 self-start text-[15px]" onClick={() => void s.reset()}>
          Reset demo data
        </Button>
      </section>
    </>
  );
}

export default withSnap(MorePage);
