"use client";
// Observation review detail: compare, verify product + exact shelf, checklist, then publish / reject / rescan.
// Rules mirror the prototype's setField / setCheck / validate; the server re-runs validate() before writing.
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { createPortal } from "react-dom";
import { reviewObservationDemo, saveReviewDraftDemo } from "@/lib/demo/adapter";
import { regionOf } from "@/lib/map/graph";
import {
  brandSize, candStr, fmt, LEVELS, locLong, locLongOf, locShort, norm, SHELF_CATALOG, shelfOf, SRC, titleOf,
} from "@/lib/review/format";
import { findMatches } from "@/lib/review/matches";
import { draftFromObservation, validate } from "@/lib/review/validate";
import { AISLE_NAMES, CATEGORIES } from "@/lib/seed/demo-store";
import type { Observation, ReviewAction, ReviewDraft, ShelfLevel } from "@/lib/types";
import { useSnap, useStaff } from "./StaffProvider";
import {
  BackLink, Button, CheckRow, Checklist, controlClass, cx, DemoTag, Field, H2, PhotoSlot, Select, Sheet,
} from "./ui";

type SheetKind = "confirm" | "reject" | "rescan" | "merge" | null;
type Cand = keyof Observation["candidate"];
const LOC_KEYS: Cand[] = ["aisle", "shelf", "level"];

export function ReviewDetail({ id }: { id: string }) {
  const snap = useSnap();
  const s = useStaff();
  const router = useRouter();
  const o = snap.observations.find((x) => x.id === id);
  const [sheet, setSheet] = useState<SheetKind>(null);
  const [reason, setReason] = useState("");
  const [mergeQ, setMergeQ] = useState("");
  const [viewMatch, setViewMatch] = useState<string | null>(null);
  const [pubError, setPubError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const h1 = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    h1.current?.closest("main")?.scrollTo({ top: 0 });
    h1.current?.focus();
  }, []);

  if (!o) {
    return (
      <>
        <BackLink onClick={() => s.setReviewId(null)}>Queue</BackLink>
        <p className="m-0 text-[15px]">This observation no longer exists. It may have been reset.</p>
      </>
    );
  }

  const pub = snap.maps.published;
  const d: ReviewDraft = s.drafts[o.id] ?? draftFromObservation(o);
  const editable = o.status === "NEEDS_REVIEW";
  const checks = validate(o, d, snap.products, pub);
  const fails = checks.filter((c) => !c.ok);
  const dups = editable ? findMatches(d, snap.products, o.suggestedMatch) : [];
  const mine = o.reviewedById === snap.staff.id;
  const prod = o.productId ? snap.products.find((p) => p.id === o.productId) : undefined;
  const notice = s.notice?.id === o.id ? s.notice : null;
  const sh = shelfOf(d.shelf);

  const setField = (k: Cand | "match", v: string) => {
    const next: ReviewDraft = { ...d, [k]: v };
    if (k === "aisle") {
      const cur = shelfOf(d.shelf);
      if (!cur || cur.aisle !== v) next.shelf = "";
    }
    if (k === "match") next.targetVersion = v && v !== "new" ? (snap.products.find((p) => p.id === v)?.version ?? 1) : null;
    if ((LOC_KEYS as string[]).includes(k)) {
      next.locReset = d.locOk;
      next.locOk = false;
    } else {
      next.idReset = d.idOk;
      next.idOk = false;
    }
    s.setDraft(o.id, next);
  };
  const setCheck = (k: "idOk" | "locOk", v: boolean) =>
    s.setDraft(o.id, { ...d, [k]: v, [k === "idOk" ? "idReset" : "locReset"]: false });

  const backToQueue = () => {
    // Back to queue discards unsaved edits.
    s.setDraft(o.id, null);
    s.setReviewId(null);
  };

  const closeSheet = () => {
    if (!busy) setSheet(null);
  };

  const submit = (action: ReviewAction) =>
    start(async () => {
      setPubError(null);
      const r = await reviewObservationDemo(
        { action, observationId: o.id, obsVersion: d.obsVersion, draft: action === "publish" ? d : undefined, targetVersion: d.targetVersion, reason },
        { simulateFailure: s.simulateFailure },
      );
      s.apply(r);
      if (!r.ok) {
        // Another employee got there first: the snapshot now shows their decision; the banner explains it.
        if (r.code === "ALREADY_REVIEWED") {
          setSheet(null);
          s.setDraft(o.id, null);
          return;
        }
        setPubError(r.error);
        return;
      }
      s.setDraft(o.id, null);
      setSheet(null);
      setReason("");
      // Active-route tracking is not available in the demo backend, so no route is ever flagged here.
      s.setNotice({ id: o.id, routeFlag: false });
      const np = r.snapshot.products.find((p) => p.id === r.productId);
      s.toast(
        action === "publish" && np
          ? `Published ${np.name}. ${r.isNew ? "Added to" : "Updated in"} Published Inventory.`
          : action === "reject" ? `${o.id} rejected. Inventory unchanged.` : `${o.id} set to NEEDS_RESCAN. Inventory unchanged.`,
      );
    });

  const save = () =>
    start(async () => {
      const r = await saveReviewDraftDemo(o.id, d);
      s.apply(r);
      if (!r.ok) {
        s.toast(r.error);
        return;
      }
      s.setDraft(o.id, null);
      s.toast("Details saved. Nothing was published.");
    });

  // ── Outcome banner (live region) ──
  let banner: { title: string; body: string; extra?: string; demo: boolean; tone: "ok" | "warn" | "plain" } | null = null;
  if ((o.status === "ACCEPTED" || o.status === "EDITED") && mine && prod) {
    banner = {
      title: "✓ Successfully published", tone: "ok", demo: true,
      body: `${prod.name} is verified at ${locLong(prod)}. ${o.isNew ? "Added to" : "Updated in"} Published Inventory, removed from Pending and recorded in Activity. Shopper search and new routes use this location.`,
      extra: notice?.routeFlag ? "! 1 active shopper route used the old location and is flagged for route revalidation." : "",
    };
  } else if (o.status === "ACCEPTED" || o.status === "EDITED") {
    banner = {
      title: "! Already reviewed by another employee", tone: "warn", demo: false,
      body: `${o.reviewedBy} approved this observation ${fmt(o.reviewedAt)}. Your edits were not published.`,
    };
  } else if (o.status === "REJECTED") {
    banner = { title: "✕ Observation rejected", tone: "plain", demo: mine, body: `Reason: ${o.reason}. Official inventory was not changed.` };
  } else if (o.status === "NEEDS_RESCAN") {
    banner = { title: "↻ Rescan requested", tone: "plain", demo: mine, body: `Status: NEEDS_RESCAN. Missing evidence: ${o.reason}. Official inventory was not changed.` };
  } else if (pubError && !sheet) {
    banner = { title: "! Publishing failed", tone: "warn", demo: false, body: pubError };
  }

  const portal = (node: React.ReactNode) => (s.sheetHost ? createPortal(node, s.sheetHost) : null);

  return (
    <>
      <header className="flex flex-col gap-1 pt-2">
        <BackLink onClick={backToQueue}>Queue</BackLink>
        <span className="text-[13px] font-bold tracking-[.06em] text-muted">
          {o.id} · {SRC[o.source].toUpperCase()}
        </span>
        <h1 ref={h1} tabIndex={-1} className="m-0 font-display text-[26px] leading-[1.15] font-normal text-indigo">
          {titleOf(d)}
        </h1>
      </header>

      <div role="status" aria-live="polite" className="flex flex-col">
        {banner && (
          <div
            className={cx(
              "flex flex-col gap-1.5 rounded-[24px] border-2 px-[18px] py-4 text-charcoal",
              banner.tone === "ok" && "border-indigo bg-tint",
              banner.tone === "warn" && "border-gold bg-warn",
              banner.tone === "plain" && "border-charcoal bg-lavender",
            )}
          >
            <strong className="text-base">{banner.title}</strong>
            <span className="text-[15px] leading-[1.45]">{banner.body}</span>
            {banner.extra && <span className="text-sm leading-[1.4] font-bold">{banner.extra}</span>}
            {banner.demo && <DemoTag tone="ivory" />}
          </div>
        )}
      </div>

      <section aria-labelledby="ev-h" className="flex items-start gap-3.5 rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-4">
        <PhotoSlot label="Evidence" className="size-[72px] rounded-[20px]" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 id="ev-h" className="m-0 text-[15px] font-bold">Original observation</h2>
          <span className="text-[15px] leading-[1.4]">{candStr(o.candidate)}</span>
          <span className="text-sm leading-[1.4] text-muted [overflow-wrap:anywhere]">{o.evidence}</span>
          <span className="text-sm text-muted">
            Confidence: {o.confidence} · Seen {fmt(o.at)}
          </span>
        </div>
      </section>

      {editable && (
        <>
          {dups.length > 0 && (
            <section aria-labelledby="dup-h" className="flex flex-col gap-2.5 rounded-[26px] border-2 border-gold bg-warn px-[18px] py-4">
              <h2 id="dup-h" className="m-0 text-base font-bold">! Possible existing product found.</h2>
              <p className="m-0 text-sm leading-[1.45]">
                Products are never merged automatically. Compare the details, then merge with the matching product or confirm this is a genuinely new product.
              </p>
              {dups.map((p) => {
                const open = viewMatch === p.id;
                const on = d.match === p.id;
                return (
                  <div key={p.id} className="flex flex-col gap-2 rounded-[20px] bg-ivory px-3.5 py-3">
                    <span>
                      <strong className="block text-base">{p.name}</strong>
                      <span className="block text-sm text-muted">
                        {p.id} · {brandSize(p) || "No brand"} · {locShort(p)}
                      </span>
                    </span>
                    {open && (
                      <dl id={`match-${p.id}`} className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
                        <dt className="text-muted">Category</dt>
                        <dd className="m-0 font-semibold">{p.category ?? "—"}</dd>
                        <dt className="text-muted">Variant</dt>
                        <dd className="m-0 font-semibold">{p.variant || "—"}</dd>
                        <dt className="text-muted">Location</dt>
                        <dd className="m-0 font-semibold">{locLong(p)}</dd>
                        <dt className="text-muted">Verified</dt>
                        <dd className="m-0 font-semibold">
                          {fmt(p.location.verifiedAt)} · {p.location.verifiedBy ?? "Unknown"}
                        </dd>
                      </dl>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        aria-expanded={open}
                        aria-controls={`match-${p.id}`}
                        onClick={() => setViewMatch(open ? null : p.id)}
                        className="min-h-11 rounded-full border-2 border-indigo bg-transparent px-4 text-sm font-bold text-indigo"
                      >
                        {open ? "Hide product" : "View product"}
                      </button>
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => setField("match", on ? "" : p.id)}
                        className={cx("min-h-11 rounded-full border-2 border-indigo px-4 text-sm font-bold", on ? "bg-indigo text-white" : "bg-transparent text-indigo")}
                      >
                        {on ? "✓ Merging with this product" : "Merge with this product"}
                      </button>
                    </div>
                  </div>
                );
              })}
              <button
                type="button"
                aria-pressed={d.match === "new"}
                onClick={() => setField("match", d.match === "new" ? "" : "new")}
                className={cx(
                  "min-h-12 rounded-full border-2 border-charcoal text-[15px] font-bold",
                  d.match === "new" ? "bg-charcoal text-white" : "bg-transparent text-charcoal",
                )}
              >
                {d.match === "new" ? "✓ Confirmed as a genuinely new product" : "Confirm it is a new product"}
              </button>
            </section>
          )}

          <fieldset className="m-0 flex min-w-0 flex-col gap-3 rounded-[26px] border-[1.5px] border-card bg-ivory p-[18px]">
            <legend className="float-left w-full p-0 font-display text-xl text-indigo">Verify product</legend>
            <Field label="Product name (required)">
              <input type="text" value={d.name} onChange={(e) => setField("name", e.target.value)} placeholder="e.g. Oat Milk" className={controlClass} />
            </Field>
            <Field label="Brand">
              <input type="text" value={d.brand} onChange={(e) => setField("brand", e.target.value)} placeholder="Leave blank if unbranded" className={controlClass} />
            </Field>
            <Field label="Product category (required)">
              <Select
                value={d.category}
                onChange={(e) => setField("category", e.target.value)}
                options={[{ v: "", l: "Choose a category" }, ...CATEGORIES.map((c) => ({ v: c, l: c }))]}
              />
            </Field>
            <div role="group" aria-labelledby="sv-h" className="flex flex-col gap-1.5">
              <span id="sv-h" className="text-[15px] font-semibold">Size or variant (at least one)</span>
              <div className="grid grid-cols-2 gap-2">
                <input type="text" aria-label="Size" value={d.size} onChange={(e) => setField("size", e.target.value)} placeholder="Size, e.g. 64 oz" className={cx(controlClass, "px-4")} />
                <input type="text" aria-label="Variant" value={d.variant} onChange={(e) => setField("variant", e.target.value)} placeholder="Variant" className={cx(controlClass, "px-4")} />
              </div>
            </div>
            <Field label="Existing inventory match (required)">
              <Select
                value={d.match}
                onChange={(e) => setField("match", e.target.value)}
                options={[
                  { v: "", l: "Not checked yet" },
                  { v: "new", l: "No match: new product" },
                  ...snap.products.map((p) => ({ v: p.id, l: `${p.id} · ${p.name}${p.brand ? " · " + p.brand : ""}${p.size ? " · " + p.size : ""}` })),
                ]}
              />
            </Field>
            <CheckRow checked={d.idOk} onChange={(v) => setCheck("idOk", v)}>I have verified the product identity.</CheckRow>
            {d.idReset && (
              <p role="status" className="-mt-1 mb-0 text-sm font-semibold">
                ! Product details changed, so this confirmation was cleared. Check it again.
              </p>
            )}
          </fieldset>

          <fieldset className="m-0 flex min-w-0 flex-col gap-3 rounded-[26px] border-[1.5px] border-card bg-ivory p-[18px]">
            <legend className="float-left w-full p-0 font-display text-xl text-indigo">Verify shelf location</legend>
            <p className="m-0 text-sm leading-[1.4] text-muted">
              Choices come from published store map v{pub.version}. Approximate or unknown locations cannot be published.
            </p>
            <Field label="Aisle">
              <Select
                value={d.aisle}
                onChange={(e) => setField("aisle", e.target.value)}
                options={[{ v: "", l: "Unknown or approximate" }, ...["1", "2", "3", "4"].map((a) => ({ v: a, l: `Aisle ${a} · ${AISLE_NAMES[a]}` }))]}
              />
            </Field>
            <Field label="Shelf section">
              <Select
                value={d.shelf}
                onChange={(e) => setField("shelf", e.target.value)}
                options={[
                  { v: "", l: d.aisle ? "Choose a section" : "Choose an aisle first" },
                  ...SHELF_CATALOG.filter((c) => c.aisle === d.aisle).map((c) => {
                    const r = regionOf(pub, c.id);
                    return { v: c.id, l: `Section ${c.section} · ${r?.anchor ? "approach " + r.anchor : "not on floor plan"}` };
                  }),
                ]}
              />
            </Field>
            <Field label="Shelf level">
              <Select
                value={d.level}
                onChange={(e) => setField("level", e.target.value as ShelfLevel)}
                options={[{ v: "", l: "Choose a level" }, ...LEVELS.map((l) => ({ v: l, l: l[0].toUpperCase() + l.slice(1) }))]}
              />
            </Field>
            <CheckRow checked={d.locOk} onChange={(v) => setCheck("locOk", v)}>I have verified the exact shelf location.</CheckRow>
            {d.locReset && (
              <p role="status" className="-mt-1 mb-0 text-sm font-semibold">
                ! The aisle or shelf changed, so this confirmation was cleared. Check it again.
              </p>
            )}
          </fieldset>

          <section aria-labelledby="chk-h" className="flex flex-col gap-3 rounded-[26px] border-[1.5px] border-card bg-ivory p-[18px]">
            <H2 id="chk-h">{fails.length ? `Before publishing: ${fails.length} to fix` : "Ready to publish"}</H2>
            <Checklist items={checks} />
          </section>

          <div className="flex flex-col gap-2.5">
            <Button
              className="min-h-14 text-[17px]"
              disabled={fails.length > 0 || busy}
              aria-describedby={fails.length ? "chk-h block-h" : "chk-h"}
              onClick={() => {
                setPubError(null);
                setSheet("confirm");
              }}
            >
              Approve and Publish
            </Button>
            {fails.length > 0 && (
              <p id="block-h" className="-mt-1 mb-0 text-center text-sm text-muted">
                Publishing is off until {fails.length === 1 ? "the item" : `all ${fails.length} items`} in the checklist {fails.length === 1 ? "is" : "are"} fixed.
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="px-2.5 text-[15px]" disabled={busy} onClick={save}>Save details</Button>
              <Button variant="outline" className="px-2.5 text-[15px]" onClick={() => { setMergeQ(""); setSheet("merge"); }}>Merge with existing</Button>
              <Button variant="dark" className="px-2.5 text-[15px]" onClick={() => { setReason(""); setPubError(null); setSheet("rescan"); }}>Request rescan</Button>
              <Button variant="dark" className="px-2.5 text-[15px]" onClick={() => { setReason(""); setPubError(null); setSheet("reject"); }}>Reject observation</Button>
            </div>
            <p className="m-0 text-sm leading-[1.4] text-muted">Save details keeps your corrections on this observation without publishing.</p>
          </div>
        </>
      )}

      {!editable && (
        <div className="flex flex-col gap-2.5">
          {prod && mine && (
            <>
              <Button
                className="min-h-14"
                onClick={() => router.push(`/shopper?q=${encodeURIComponent([prod.brand, prod.name].filter(Boolean).join(" "))}`)}
              >
                Find it in shopper search
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  s.setReviewId(null);
                  s.setFp({ mode: "view", sel: null });
                  s.openShelf(prod.location.shelfId);
                  router.push("/business/floor-plan");
                }}
              >
                Show on floor plan
              </Button>
              <Button variant="outline" onClick={() => { s.setReviewId(null); router.push("/business/inventory"); }}>
                View Published Inventory
              </Button>
            </>
          )}
          <Button variant="dark" onClick={backToQueue}>Back to queue</Button>
        </div>
      )}

      {sheet === "confirm" && sh && portal(
        <Sheet labelledBy="rcf-h" onClose={closeSheet} maxH="88%">
          <h2 id="rcf-h" className="m-0 font-display text-2xl font-normal text-indigo">Publish to inventory?</h2>
          <DemoTag />
          <div className="rounded-[22px] bg-lavender px-4 py-3.5">
            <span className="block text-[13px] font-bold tracking-[.04em] text-muted">✓ VERIFIED PRODUCT</span>
            <span className="mt-0.5 block text-lg font-bold text-indigo">{d.name}</span>
            <span className="mt-0.5 block text-sm">{[d.brand, d.variant, d.size].filter(Boolean).join(" · ") || "No brand"}</span>
          </div>
          <div className="rounded-[22px] bg-lavender px-4 py-3.5">
            <span className="block text-[13px] font-bold tracking-[.04em] text-muted">✓ VERIFIED SHELF LOCATION</span>
            <span className="mt-0.5 block text-lg font-bold text-indigo">{locLongOf({ shelfId: d.shelf, level: d.level })}</span>
            <span className="mt-0.5 block text-sm">
              {AISLE_NAMES[sh.aisle]} · route destination {regionOf(pub, sh.id)?.anchor || "none"}
            </span>
          </div>
          {(() => {
            const t = d.match !== "new" ? snap.products.find((p) => p.id === d.match) : undefined;
            const to = locLongOf({ shelfId: d.shelf, level: d.level });
            return (
              <div className="rounded-[22px] border-2 border-control px-4 py-3.5">
                <span className="block text-[13px] font-bold tracking-[.04em] text-muted">{t ? "UPDATE TO AN EXISTING PRODUCT" : "NEW PRODUCT"}</span>
                <span className="mt-0.5 block text-[15px] leading-[1.45]">
                  {t
                    ? `Merges into ${t.id} ${t.name}. ${locLong(t) === to ? "Shelf location stays the same; the product details are re-verified." : "Location changes from " + locLong(t) + "."}`
                    : "Adds a new product to Published Inventory. No existing product is changed."}
                </span>
              </div>
            );
          })()}
          {busy && <p role="status" className="m-0 text-[15px] font-semibold">Publishing… checking authorization, revalidating and writing in one transaction.</p>}
          {pubError && (
            <div role="alert" className="rounded-[22px] border-2 border-gold bg-warn px-4 py-3.5 text-[15px] leading-[1.45]">
              <strong className="block">! Publishing failed</strong>
              {pubError}
            </div>
          )}
          <div className="mt-1 flex gap-2.5">
            <Button variant="dark" className="flex-1 px-2" disabled={busy} onClick={closeSheet}>Cancel</Button>
            <Button className="flex-[1.4] px-2" disabled={busy} onClick={() => submit("publish")}>
              {busy ? "Publishing…" : pubError ? "Try again" : "Confirm and publish"}
            </Button>
          </div>
        </Sheet>,
      )}

      {(sheet === "reject" || sheet === "rescan") && portal(
        <ReasonSheet
          kind={sheet}
          reason={reason}
          setReason={setReason}
          busy={busy}
          error={pubError}
          onClose={closeSheet}
          onSubmit={() => submit(sheet)}
        />,
      )}

      {sheet === "merge" && portal(
        <Sheet labelledBy="rm-h" onClose={closeSheet}>
          <h2 id="rm-h" className="m-0 font-display text-2xl font-normal text-indigo">Merge with existing</h2>
          <p className="m-0 text-[15px] leading-[1.45]">
            Choose the verified product this observation belongs to. Its record is updated instead of creating a duplicate.
          </p>
          <label className="flex flex-col gap-1.5 text-[15px] font-bold">
            Search inventory
            <input type="search" value={mergeQ} onChange={(e) => setMergeQ(e.target.value)} placeholder="Name, brand or alias" className={cx(controlClass, "px-5")} />
          </label>
          {(() => {
            const dupIds = findMatches(d, snap.products, o.suggestedMatch).map((p) => p.id);
            const q = norm(mergeQ);
            return snap.products
              .filter((p) => !q || norm([p.name, p.brand, ...p.aliases].join(" ")).includes(q))
              .sort((a, b) => Number(dupIds.includes(b.id)) - Number(dupIds.includes(a.id)))
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={d.match === p.id}
                  onClick={() => {
                    setField("match", p.id);
                    setSheet(null);
                    s.toast(`Will merge with ${p.name}. Confirm the product identity again.`);
                  }}
                  className="flex min-h-14 items-center justify-between gap-2.5 rounded-[20px] border-0 bg-lavender px-4 py-3 text-left text-charcoal"
                >
                  <span>
                    <span className="block text-base font-bold">{d.match === p.id ? "✓ " : ""}{p.name}</span>
                    <span className="block text-sm text-muted">
                      {p.id} · {brandSize(p) || "No brand"} · {locShort(p)}
                    </span>
                  </span>
                  {dupIds.includes(p.id) && <span className="flex-none rounded-full bg-gold px-2.5 py-[3px] text-xs font-bold text-charcoal">Possible match</span>}
                </button>
              ));
          })()}
          <Button variant="dark" onClick={closeSheet}>Cancel</Button>
        </Sheet>,
      )}
    </>
  );
}

const REASONS = {
  reject: {
    title: "Reject observation", help: "The observation is marked REJECTED. Official inventory is not changed.", label: "Rejection reason",
    chips: ["Not sold in this store", "Duplicate of a published product", "Wrong product identified"], cta: "Reject observation",
  },
  rescan: {
    title: "Request rescan", help: "The status changes to NEEDS_RESCAN. Official inventory is not changed.", label: "What evidence is missing?",
    chips: ["Size label not visible", "Shelf section not visible", "Product label turned away"], cta: "Request rescan",
  },
} as const;

function ReasonSheet({
  kind, reason, setReason, busy, error, onClose, onSubmit,
}: {
  kind: "reject" | "rescan"; reason: string; setReason: (v: string) => void; busy: boolean; error: string | null;
  onClose: () => void; onSubmit: () => void;
}) {
  const R = REASONS[kind];
  const dis = busy || reason.trim().length < 5;
  return (
    <Sheet labelledBy="rr-h" onClose={onClose} maxH="88%">
      <h2 id="rr-h" className="m-0 font-display text-2xl font-normal text-indigo">{R.title}</h2>
      <p className="m-0 text-[15px] leading-[1.45]">{R.help}</p>
      <div role="group" aria-label="Common reasons" className="flex flex-wrap gap-2">
        {R.chips.map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setReason(c)}
            className="sg-outline min-h-11 rounded-full border-2 border-control bg-ivory px-3.5 text-sm font-semibold text-charcoal"
          >
            {c}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1.5 text-[15px] font-bold">
        {R.label} (required)
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          aria-describedby="rr-hint"
          className="resize-y rounded-[22px] border-2 border-control bg-ivory px-[18px] py-3.5 text-base font-normal text-charcoal"
        />
      </label>
      <p id="rr-hint" className="m-0 text-sm text-muted">At least 5 characters. Demo action · local demo state only.</p>
      {busy && <p role="status" className="m-0 text-[15px] font-semibold">Saving decision…</p>}
      {error && <p role="alert" className="m-0 rounded-[22px] border-2 border-gold bg-warn px-4 py-3.5 text-[15px]">{error}</p>}
      <div className="flex gap-2.5">
        <Button variant="dark" className="flex-1 px-2" onClick={onClose}>Cancel</Button>
        <Button variant="charcoal" className="flex-[1.4] px-2" disabled={dis} onClick={onSubmit}>{R.cta}</Button>
      </div>
    </Sheet>
  );
}
