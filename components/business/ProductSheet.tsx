"use client";
import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { moveProduct } from "@/lib/staff/client";
import { brandSize, fmt, LEVELS, locLong, locLongOf, SHELF_CATALOG } from "@/lib/review/format";
import { AISLE_NAMES } from "@/lib/seed/demo-store";
import type { ShelfLevel } from "@/lib/types";
import { useSnap, useStaff } from "./StaffProvider";
import { AlertDialog, Button, Field, ICON, PhotoSlot, Select, Sheet } from "./ui";

export function ProductSheet() {
  const snap = useSnap();
  const s = useStaff();
  const p = snap.products.find((x) => x.id === s.productSheet);
  const [shelf, setShelf] = useState(p?.location.shelfId ?? "");
  const [level, setLevel] = useState<ShelfLevel>(p?.location.level ?? "middle");
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  if (!p) return null;

  const close = () => s.openProduct(null);
  const unchanged = shelf === p.location.shelfId && level === p.location.level;
  const to = locLongOf({ shelfId: shelf, level });

  const publish = () =>
    start(async () => {
      setError(null);
      const r = await moveProduct(p.id, shelf, level, p.version ?? 1);
      // No snapshot from the route: re-read it (after a 409 too, so the sheet shows the current location).
      await s.refresh();
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setConfirm(false);
      s.openProduct(null);
      s.toast(`Published. Shopper routes for ${p.name} now target ${to}.`);
    });

  return (
    <>
      <Sheet labelledBy="prod-sheet-h" onClose={close}>
        <div className="flex items-start gap-3.5">
          <PhotoSlot label="Product photo" className="size-[88px] rounded-[22px]" />
          <div className="min-w-0 flex-1">
            <h2 id="prod-sheet-h" className="m-0 font-display text-[22px] leading-[1.15] font-normal text-indigo">{p.name}</h2>
            <p className="mt-1 mb-0 text-[15px] text-muted">{brandSize(p) || "No brand"}</p>
          </div>
          <button type="button" onClick={close} aria-label="Close product details" className="flex size-11 flex-none items-center justify-center rounded-full border-0 bg-lavender text-charcoal">
            <X size={20} {...ICON} />
          </button>
        </div>
        <div className="rounded-[22px] bg-lavender px-4 py-3.5 text-charcoal">
          <span className="block text-[13px] font-bold tracking-[.04em] text-muted">✓ PUBLISHED LOCATION</span>
          <span className="mt-0.5 block text-lg font-bold text-indigo">{locLong(p)}</span>
          <span className="mt-0.5 block text-sm">
            Verified {fmt(p.location.verifiedAt)} · {p.location.verifiedBy ?? "Unknown"}
          </span>
        </div>
        <h3 className="mt-1 mb-0 text-base font-bold">Move to</h3>
        <Field label="Shelf section">
          <Select
            value={shelf}
            onChange={(e) => setShelf(e.target.value)}
            options={SHELF_CATALOG.map((c) => ({ v: c.id, l: `Aisle ${c.aisle} · Section ${c.section} (${AISLE_NAMES[c.aisle]})` }))}
          />
        </Field>
        <Field label="Shelf level">
          <Select
            value={level}
            onChange={(e) => setLevel(e.target.value as ShelfLevel)}
            className="capitalize"
            options={LEVELS.map((l) => ({ v: l, l }))}
          />
        </Field>
        <Button className="min-h-14 text-[17px]" disabled={unchanged} aria-describedby={unchanged ? "move-hint" : undefined} onClick={() => setConfirm(true)}>
          Review and publish
        </Button>
        {unchanged && (
          <p id="move-hint" className="-mt-1.5 mb-0 text-center text-sm text-muted">
            Pick a different shelf or level to publish a move.
          </p>
        )}
      </Sheet>

      {confirm && (
        <AlertDialog labelledBy="cf-h" describedBy="cf-b" onClose={() => !busy && setConfirm(false)}>
          <h2 id="cf-h" className="m-0 font-display text-[22px] font-normal text-indigo">Publish this move?</h2>
          <p id="cf-b" className="m-0 text-[15px] leading-normal">
            {p.name} will be published to the shared inventory. The next shopper route will use the new shelf.
          </p>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[15px]">
            <dt className="text-muted">From</dt>
            <dd className="m-0 font-bold">{locLong(p)}</dd>
            <dt className="text-muted">To</dt>
            <dd className="m-0 font-bold">{to}</dd>
          </dl>
          {busy && <p role="status" className="m-0 text-[15px] font-semibold">Publishing…</p>}
          {error && (
            <p role="alert" className="m-0 rounded-[22px] border-2 border-gold bg-warn px-4 py-3.5 text-[15px]">
              {error}
            </p>
          )}
          <div className="mt-1.5 flex gap-2.5">
            <Button variant="dark" className="flex-1 px-2" disabled={busy} onClick={() => setConfirm(false)}>Cancel</Button>
            <Button className="flex-1 px-2" disabled={busy} onClick={publish}>{error ? "Try again" : "Publish"}</Button>
          </div>
        </AlertDialog>
      )}
    </>
  );
}
