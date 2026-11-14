"use client";
// Shopper sightings: changes suggested by shopper camera scans (adaptive inventory). Nothing reaches shoppers until
// an employee approves it here. Approvals write the same in-memory store as Review and Inventory, and are logged
// to Activity.
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { getStaffSnapshotDemo } from "@/lib/demo/adapter";
import { listSightingsDemo, reviewSightingDemo, type SightingsSnapshot } from "@/lib/demo/sightings";
import { LEVELS } from "@/lib/review/format";
import { useStaff, withSnap } from "@/components/business/StaffProvider";
import { BackLink, Button, controlClass, cx, DemoTag, Field, PageHeader, Select } from "@/components/business/ui";
import type { Suggestion } from "@/lib/inventory/store";

const KIND = {
  NEW_PRODUCT: { label: "New item", tone: "bg-tint" },
  MOVED: { label: "Moved", tone: "bg-warn" },
  MISSING: { label: "Possibly gone", tone: "bg-charcoal text-white" },
} as const;
const FIELDS = [["name", "Name"], ["brand", "Brand"], ["variant", "Variant"], ["size", "Size"], ["category", "Category"]] as const;

const title = (p: { name: string; brand: string | null; size: string | null }) => [p.brand, p.name, p.size].filter(Boolean).join(" ") || "Unidentified item";
const shelfName = (id: string) => id.replace(/^S-A(\w+)-(\w+)$/, "Aisle $1, Section $2");
function ago(iso: string | null): string {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function SightingCard({ s, busy, onReview }: { s: Suggestion; busy: boolean; onReview: (s: Suggestion, action: "approve" | "reject", form?: FormData) => void }) {
  const shelves = Object.entries(s.shelf_counts).sort((a, b) => b[1] - a[1]);
  const k = KIND[s.kind];
  const h = `sg-${s.id}`;
  return (
    <li>
      <form
        aria-labelledby={h}
        onSubmit={(e) => {
          e.preventDefault();
          onReview(s, "approve", new FormData(e.currentTarget));
        }}
        className="flex flex-col gap-3 rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-4"
      >
        <span className="flex flex-wrap gap-1.5">
          <span className={cx("rounded-full px-2.5 py-1 text-[13px] font-bold", k.tone, s.kind !== "MISSING" && "text-charcoal")}>{k.label}</span>
          <span className="rounded-full bg-lavender px-2.5 py-1 text-[13px] font-bold text-indigo">
            {s.sighting_count} sighting{s.sighting_count === 1 ? "" : "s"} · {ago(s.last_seen_at)}
          </span>
        </span>
        <strong id={h} className="text-[17px] leading-[1.3]">{title(s.proposed)}</strong>
        {s.proposed.category && <span className="-mt-2 text-sm text-muted">{s.proposed.category}</span>}
        {s.evidence[0] && <p className="m-0 rounded-[20px] bg-lavender px-3.5 py-2.5 text-sm leading-[1.4]">“{s.evidence[0]}”</p>}

        {s.kind === "NEW_PRODUCT" && (
          <div className="grid grid-cols-2 gap-2.5">
            {FIELDS.map(([f, l]) => (
              <div key={f} className={f === "name" ? "col-span-2" : undefined}>
                <Field label={l}>
                  <input name={f} defaultValue={s.proposed[f] ?? ""} required={f === "name"} className={controlClass} />
                </Field>
              </div>
            ))}
          </div>
        )}

        {s.kind !== "MISSING" ? (
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Shelf">
              <Select name="shelf_id" options={shelves.map(([id, n]) => ({ v: id, l: `${shelfName(id)} (${n})` }))} />
            </Field>
            <Field label="Level">
              <Select name="level" defaultValue="" options={[{ v: "", l: "Unknown" }, ...LEVELS.map((l) => ({ v: l, l: l[0].toUpperCase() + l.slice(1) }))]} />
            </Field>
          </div>
        ) : (
          <p className="m-0 text-[15px] leading-[1.4]">
            Approving removes it from shopper search{shelves[0] ? ` at ${shelfName(shelves[0][0])}` : ""}.
          </p>
        )}

        <div className="grid grid-cols-2 gap-2.5">
          <Button type="button" variant="outline" disabled={busy} onClick={() => onReview(s, "reject")}>Reject</Button>
          <Button type="submit" disabled={busy}>Approve</Button>
        </div>
      </form>
    </li>
  );
}

function SightingsPage() {
  const router = useRouter();
  const st = useStaff();
  const { apply, toast } = st;
  const [data, setData] = useState<SightingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await listSightingsDemo();
    if (r.ok) {
      setData(r.sightings);
      setError(null);
    } else setError(r.error);
  }, []);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 10_000); // new shopper sightings appear without a reload
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function review(s: Suggestion, action: "approve" | "reject", form?: FormData) {
    const edits = s.kind === "NEW_PRODUCT" && form ? Object.fromEntries(FIELDS.map(([f]) => [f, String(form.get(f) ?? "").trim() || null])) : undefined;
    setBusy(s.id);
    const r = await reviewSightingDemo({
      id: s.id, action,
      shelfId: (form?.get("shelf_id") as string) || undefined,
      level: (form?.get("level") as string) || null,
      edits,
    });
    setBusy(null);
    if (!r.ok) {
      toast(r.error);
      void load();
      return;
    }
    setData(r.sightings);
    toast(r.message);
    // Keep Home, Inventory and Activity in step with the change.
    const snap = await getStaffSnapshotDemo();
    if (snap.ok) apply(snap);
  }

  return (
    <>
      <PageHeader
        back={<BackLink onClick={() => router.push("/business/more")}>More</BackLink>}
        title="Shopper sightings"
        sub="Shopper cameras suggest changes. Nothing is added, moved or removed until you approve it."
      />
      <DemoTag />
      {error && <p role="alert" className="m-0 rounded-[26px] bg-warn px-[18px] py-4 text-[15px] font-semibold text-charcoal">{error}</p>}

      <section aria-labelledby="queue-h" className="flex flex-col gap-2.5">
        <h2 id="queue-h" className="m-0 font-display text-xl font-normal text-indigo">
          Needs review{data ? ` (${data.queue.length})` : ""}
        </h2>
        {!data && !error && <p className="m-0 text-[15px] text-muted" role="status">Loading sightings…</p>}
        {data && !data.queue.length && (
          <p className="m-0 rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-4 text-[15px]">
            Nothing to review. When several shoppers&apos; cameras agree an item is new, moved or gone, it appears here.
          </p>
        )}
        {data && data.queue.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {data.queue.map((s) => <SightingCard key={s.id} s={s} busy={busy === s.id} onReview={review} />)}
          </ul>
        )}
      </section>

      {data && (
        <section aria-labelledby="unseen-h" className="flex flex-col gap-2.5">
          <h2 id="unseen-h" className="m-0 font-display text-xl font-normal text-indigo">Not seen on recent scans</h2>
          <p className="m-0 text-sm text-muted">
            {data.lastSeenCount} of {data.total} products seen by shopper cameras so far.
          </p>
          {!data.unseen.length ? (
            <p className="m-0 rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-4 text-[15px]">Every listed product was seen on its last scan.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {data.unseen.map((i) => (
                <li key={i.product_id}>
                  <button
                    type="button"
                    onClick={() => st.openProduct(i.product_id)}
                    className="flex w-full flex-col gap-[3px] rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-3.5 text-left text-charcoal"
                  >
                    <span className="text-base leading-[1.25] font-bold">{title(i)}</span>
                    <span className="text-sm text-muted">
                      Aisle {i.aisle}, Section {i.section} · last seen {ago(i.last_seen_at)}
                    </span>
                    <span className="self-start rounded-full bg-warn px-2.5 py-[3px] text-[13px] font-bold text-charcoal">
                      Missed on {i.miss_count} scan{i.miss_count === 1 ? "" : "s"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

export default withSnap(SightingsPage);
