"use client";
// Floor plan: View published / Edit draft. Shoppers and approvals keep using the published version until publish.
import { useTransition, type ChangeEvent } from "react";
import { Upload } from "lucide-react";
import { publishMap, saveMapDraft } from "@/lib/staff/client";
import { cloneMap, KIND_TXT, mapChecks, regionOf, routeTo } from "@/lib/map/graph";
import { fmt, norm, SHELF_CATALOG, shelfOf } from "@/lib/review/format";
import { AISLE_NAMES } from "@/lib/seed/demo-store";
import type { FloorPlan } from "@/lib/types";
import { FloorPlanViewer, edgeKey } from "@/components/map/FloorPlanViewer";
import { isPdfName, readPlanFile } from "@/components/map/planFile";
import { useSnap, useStaff, type FloorPlanUi, withSnap } from "@/components/business/StaffProvider";
import { pendingAt, pendingObs, plural, productsAt } from "@/components/business/derive";
import {
  AlertDialog, Button, CheckRow, Checklist, controlClass, cx, Field, H2, Pill, Select,
} from "@/components/business/ui";

const TOOLS: [FloorPlanUi["tool"], string][] = [
  ["select", "Select"], ["shelf", "+ Shelf"], ["entrance", "+ Entrance"], ["landmark", "+ Landmark"], ["walk", "+ Walk point"], ["connect", "Connect paths"],
];
const TOOL_HINT: Record<FloorPlanUi["tool"], string> = {
  select: "Tap a shelf, point or landmark to edit it. Drag to pan.",
  shelf: "Tap the plan where a shelf is to place a shelf region, then choose its shelf ID.",
  entrance: "Tap an entrance on the plan to label it.",
  landmark: "Tap a fixed, recognizable feature such as a sign or desk to add a localization landmark.",
  walk: "Tap open floor to add a walkable point.",
  connect: "Tap two walkable points to connect them. Only connect points a person can walk between: distance on the image is not proof.",
};
const pad = (n: number) => "N" + String(n).padStart(2, "0");

function FloorPlanPage() {
  const snap = useSnap();
  const s = useStaff();
  const { fp, setFp } = s;
  const [busy, start] = useTransition();
  const pub = snap.maps.published;
  const isEdit = fp.mode === "edit" && !!fp.draft;
  const m: FloorPlan = isEdit ? fp.draft! : pub;
  const S = isEdit ? fp.sel : null;

  const patch = (fn: (d: FloorPlan) => void) =>
    setFp((st) => {
      if (!st.draft) return {};
      const d = cloneMap(st.draft);
      fn(d);
      return { draft: d, dirty: true };
    });

  const setMode = (mode: FloorPlanUi["mode"]) => {
    s.openShelf(null);
    setFp((st) => ({
      mode, sel: null, connectFrom: null, route: "", view: { z: 1, tx: 0, ty: 0 },
      draft: mode === "edit" && !st.draft ? cloneMap(snap.maps.draft ?? pub) : st.draft,
    }));
  };

  const place = (x: number, y: number) => {
    const d0 = fp.draft;
    if (!d0) return;
    if (fp.tool === "shelf") {
      const key = "r" + Date.now();
      patch((d) => d.shelves.push({ key, id: "", x: Math.max(0, Math.min(0.93, x - 0.035)), y: Math.max(0, Math.min(0.88, y - 0.06)), w: 0.07, h: 0.12, anchor: "" }));
      setFp({ sel: { type: "shelf", key } });
      s.toast("Shelf region placed. Choose its shelf ID and approach point below the map.");
    } else if (fp.tool === "entrance" || fp.tool === "walk") {
      const id = pad(Math.max(0, ...d0.nodes.map((n) => +n.id.slice(1) || 0)) + 1);
      const kind = fp.tool === "entrance" ? "entrance" : "walk";
      patch((d) => d.nodes.push({ id, x, y, kind }));
      setFp({ sel: { type: "node", key: id } });
      s.toast(`${KIND_TXT[kind]} ${id} added.`);
    } else if (fp.tool === "landmark") {
      const id = "L" + String(Math.max(0, ...d0.landmarks.map((l) => +l.id.slice(1) || 0)) + 1).padStart(2, "0");
      patch((d) => d.landmarks.push({ id, x, y, label: "", verified: false }));
      setFp({ sel: { type: "landmark", key: id } });
      s.toast(`Landmark ${id} added. Name it below the map.`);
    }
  };

  const nodeTap = (id: string) => {
    if (!isEdit || !fp.draft) return;
    if (fp.tool === "connect") {
      const from = fp.connectFrom;
      if (!from || from === id) {
        setFp({ connectFrom: from === id ? null : id });
        return;
      }
      if (!fp.draft.edges.some((e) => e.includes(from) && e.includes(id))) {
        patch((d) => d.edges.push([from, id]));
        s.toast(`Connected ${from} and ${id} as walkable.`);
      }
      setFp({ connectFrom: id });
      return;
    }
    setFp({ sel: { type: "node", key: id } });
  };

  const remove = () => {
    if (!S) return;
    patch((d) => {
      if (S.type === "shelf") d.shelves = d.shelves.filter((x) => x.key !== S.key);
      if (S.type === "landmark") d.landmarks = d.landmarks.filter((x) => x.id !== S.key);
      if (S.type === "node") {
        d.nodes = d.nodes.filter((n) => n.id !== S.key);
        d.edges = d.edges.filter((e) => !e.includes(S.key));
        d.shelves.forEach((r) => {
          if (r.anchor === S.key) r.anchor = "";
        });
      }
    });
    setFp({ sel: null, connectFrom: null });
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    try {
      const { url, aspect, kind } = await readPlanFile(f);
      // A new image starts a blank draft: old coordinates never carry over to a different plan.
      setFp({
        draft: { mapId: pub.mapId, version: pub.version, plan: { url, name: f.name, kind }, aspect, nodes: [], edges: [], shelves: [], landmarks: [] },
        mode: "edit", tool: "shelf", sel: null, connectFrom: null, route: "", view: { z: 1, tx: 0, ty: 0 }, dirty: true,
      });
      s.toast(`${f.name} is the draft background. Shelves, entrances and paths start empty: mark them on the plan.`);
    } catch {
      s.toast(isPdfName(f) ? "Could not render that PDF here. Try a PNG or JPG export of the floor plan." : "Could not read that image. Upload a PNG, JPG or PDF floor plan.");
    }
  };

  const checks = isEdit ? mapChecks(m, snap.products) : [];
  const fails = checks.filter((c) => !c.ok);

  const save = () =>
    start(async () => {
      if (!fp.draft) return;
      // PUT /api/maps/:id/graph returns no snapshot: re-read it so "Draft saved <time>" is current.
      const r = await saveMapDraft(pub.mapId, fp.draft);
      await s.refresh();
      if (!r.ok) return s.toast(r.error);
      setFp({ dirty: false });
      s.toast(`Draft saved. Shoppers still use published v${pub.version}.`);
    });

  const publish = () =>
    start(async () => {
      if (!fp.draft) return;
      // PUT the draft, then POST /api/maps/:id/publish (the server re-runs the checklist), then re-read the snapshot.
      const r = await publishMap(pub.mapId, fp.draft);
      await s.refresh();
      if (!r.ok) {
        setFp({ confirm: false });
        return s.toast(r.failing?.length ? `${r.error} ${r.failing.join("; ")}.` : r.error);
      }
      setFp({ confirm: false, mode: "view", draft: null, sel: null, connectFrom: null, dirty: false, view: { z: 1, tx: 0, ty: 0 } });
      s.toast(`Floor plan v${r.version} published. New approvals and routes use it.`);
    });

  // Route preview (editor only): BFS from entrances over drawn edges.
  const routeShelf = isEdit && fp.route ? regionOf(m, fp.route) : undefined;
  const route = routeShelf?.anchor ? routeTo(m, routeShelf.anchor) : null;
  const routeEdges = new Set<string>();
  (route ?? []).forEach((n, i) => i && routeEdges.add(edgeKey(route![i - 1], n)));

  // Text alternative.
  const fq = norm(fp.q);
  const list = m.shelves
    .filter((r) => r.id && shelfOf(r.id))
    .map((r) => {
      const c = shelfOf(r.id)!;
      const ps = productsAt(snap, r.id);
      const pend = pendingAt(snap, r.id);
      const hit = fq ? ps.filter((p) => norm([p.name, p.brand, ...p.aliases].join(" ")).includes(fq)) : [];
      const hay = norm([r.id, "aisle " + c.aisle, "section " + c.section, AISLE_NAMES[c.aisle]].join(" "));
      return { r, c, ps, pend, hit, show: !fq || hay.includes(fq) || hit.length > 0 };
    })
    .filter((i) => i.show)
    .sort((a, b) => a.r.id.localeCompare(b.r.id));
  const uncertainN = pendingObs(snap).filter((o) => !shelfOf(o.candidate.shelf)).length;
  const ents = m.nodes.filter((n) => n.kind === "entrance").map((n) => n.id);
  const helps = m.nodes.filter((n) => n.kind === "service").map((n) => n.id);

  // Selection panel data.
  const nById = Object.fromEntries(m.nodes.map((n) => [n.id, n]));
  const selShelf = S?.type === "shelf" ? m.shelves.find((x) => x.key === S.key) : undefined;
  const selNode = S?.type === "node" ? nById[S.key] : undefined;
  const selLm = S?.type === "landmark" ? m.landmarks.find((x) => x.id === S.key) : undefined;
  const selTitle = selShelf ? (selShelf.id ? `Shelf ${selShelf.id}` : "New shelf region") : selNode ? `${KIND_TXT[selNode.kind] || "Point"} ${selNode.id}` : selLm ? `Landmark ${selLm.id}` : "";

  return (
    <>
      <header className="flex flex-col gap-0.5 pt-2">
        <h1 className="m-0 font-display text-[28px] font-normal text-indigo">Floor plan</h1>
        <p className="m-0 text-[15px] text-muted">
          {isEdit
            ? `Editing draft · based on published v${pub.version}`
            : `Published v${pub.version} · ${pub.shelves.filter((r) => r.id).length} shelves · ${pub.edges.length} walkable connections`}
        </p>
      </header>
      <div role="group" aria-label="Floor plan mode" className="grid grid-cols-2 gap-2">
        <Pill on={fp.mode === "view"} onClick={() => setMode("view")} className="min-h-12 text-[15px]">View published</Pill>
        <Pill on={fp.mode === "edit"} onClick={() => setMode("edit")} className="min-h-12 text-[15px]">Edit draft</Pill>
      </div>

      {isEdit && (
        <>
          <label className="sg-file relative flex min-h-[52px] items-center justify-center gap-2.5 rounded-full border-2 border-indigo text-base font-bold text-indigo">
            <Upload size={20} strokeWidth={2.75} aria-hidden="true" />
            Upload floor plan (image or PDF)
            <input type="file" accept="image/*,application/pdf" onChange={onFile} className="absolute size-px overflow-hidden opacity-0" />
          </label>
          <div role="group" aria-label="Editing tool" className="flex gap-2 overflow-x-auto pb-0.5">
            {TOOLS.map(([v, l]) => (
              <Pill key={v} on={fp.tool === v} onClick={() => setFp({ tool: v, connectFrom: null })} className="min-h-11 flex-none px-3.5 text-sm">
                {l}
              </Pill>
            ))}
          </div>
          <p role="status" className="m-0 text-sm leading-[1.4]">
            {fp.tool === "connect" && fp.connectFrom
              ? `Connecting from ${fp.connectFrom}. Tap the next walkable point, or tap ${fp.connectFrom} again to stop.`
              : TOOL_HINT[fp.tool]}
          </p>
        </>
      )}

      <FloorPlanViewer
        map={m}
        isEdit={isEdit}
        placing={["shelf", "entrance", "walk", "landmark"].includes(fp.tool)}
        view={fp.view}
        setView={(view) => setFp({ view })}
        verifiedAt={(id) => productsAt(snap, id).length}
        pendingAt={(id) => pendingAt(snap, id).length}
        highlightShelf={(key, id) => (isEdit ? S?.type === "shelf" && S.key === key : s.shelfSheet === id)}
        highlightNode={(id) => isEdit && ((S?.type === "node" && S.key === id) || fp.connectFrom === id)}
        highlightLandmark={(id) => isEdit && S?.type === "landmark" && S.key === id}
        routeEdges={routeEdges}
        onShelf={(key, id) => (isEdit ? setFp({ sel: { type: "shelf", key } }) : id && s.openShelf(id))}
        onNode={nodeTap}
        onLandmark={(id) => isEdit && setFp({ sel: { type: "landmark", key: id } })}
        onPlace={place}
      />
      <p className="-mt-2 mb-0 text-[13px] leading-[1.45] text-muted">
        Pinch or use + and − to zoom; drag to pan. Filled shelves have verified products. A gold dashed badge counts pending observations, which are not published. Gold dots: entrance and help desk. Diamonds: landmarks. Dotted lines: walkable paths.
      </p>

      {isEdit && (
        <>
          {S && selTitle && (
            <section aria-labelledby="fsel-h" className="flex flex-col gap-3 rounded-[26px] border-[1.5px] border-card bg-ivory p-[18px]">
              <div className="flex items-center gap-2.5">
                <H2 id="fsel-h" className="flex-1">{selTitle}</H2>
                <Button variant="dark" className="min-h-11 px-4 text-sm" onClick={remove}>Delete</Button>
              </div>
              {selShelf && (() => {
                const used = new Set(m.shelves.filter((x) => x.key !== selShelf.key && x.id).map((x) => x.id));
                return (
                  <>
                    <Field label="Shelf ID">
                      <Select
                        value={selShelf.id}
                        onChange={(e) => patch((d) => { d.shelves.find((x) => x.key === selShelf.key)!.id = e.target.value; })}
                        options={[{ v: "", l: "Choose a shelf ID" }, ...SHELF_CATALOG.map((c) => ({ v: c.id, l: `${c.id} · Aisle ${c.aisle}, Section ${c.section}${used.has(c.id) ? " (already placed)" : ""}` }))]}
                      />
                    </Field>
                    <Field label="Walkable approach point">
                      <Select
                        value={selShelf.anchor}
                        onChange={(e) => patch((d) => { d.shelves.find((x) => x.key === selShelf.key)!.anchor = e.target.value; })}
                        options={[{ v: "", l: "Choose an approach point" }, ...m.nodes.filter((n) => n.kind !== "entrance" && n.kind !== "service").map((n) => ({ v: n.id, l: `${n.id} · ${KIND_TXT[n.kind] || "Point"}` }))]}
                      />
                    </Field>
                    <p className="m-0 text-sm leading-[1.4] text-muted">Shoppers are routed to the approach point, so it must be a walk point connected to the path network.</p>
                  </>
                );
              })()}
              {selNode && (() => {
                const links = m.edges.filter((e) => e.includes(selNode.id)).map((e) => (e[0] === selNode.id ? e[1] : e[0]));
                return links.length ? (
                  links.map((o) => (
                    <div key={o} className="flex items-center gap-2.5 text-[15px]">
                      <span className="flex-1">Walkable to {o}</span>
                      <button
                        type="button"
                        onClick={() => patch((d) => { d.edges = d.edges.filter((e) => !(e.includes(selNode.id) && e.includes(o))); })}
                        className="min-h-11 rounded-full border-2 border-control bg-transparent px-3.5 text-sm font-bold text-charcoal"
                      >
                        Remove
                      </button>
                    </div>
                  ))
                ) : (
                  <p className="m-0 text-sm">No walkable connections yet. Use Connect paths.</p>
                );
              })()}
              {selLm && (
                <>
                  <Field label="Landmark name">
                    <input
                      type="text"
                      value={selLm.label}
                      placeholder="e.g. Pharmacy sign"
                      maxLength={300} // same cap as the server schema (lib/demo adapter); landmark descriptions are long
                      onChange={(e) => patch((d) => { d.landmarks.find((x) => x.id === selLm.id)!.label = e.target.value; })}
                      className={controlClass}
                    />
                  </Field>
                  <CheckRow checked={selLm.verified} onChange={(v) => patch((d) => { d.landmarks.find((x) => x.id === selLm.id)!.verified = v; })}>
                    I verified this landmark on site.
                  </CheckRow>
                </>
              )}
            </section>
          )}

          <section aria-labelledby="rt-h" className="flex flex-col gap-3 rounded-[26px] border-[1.5px] border-card bg-ivory p-[18px]">
            <H2 id="rt-h">Preview route</H2>
            <Field label="From the entrance to">
              <Select
                value={fp.route}
                onChange={(e) => setFp({ route: e.target.value })}
                options={[{ v: "", l: "Choose a shelf" }, ...m.shelves.filter((r) => r.id).map((r) => ({ v: r.id, l: r.id }))]}
              />
            </Field>
            <p role="status" className="m-0 text-[15px] leading-[1.45]">
              {!fp.route
                ? "Choose a shelf to check its route over the paths you connected."
                : !routeShelf?.anchor
                  ? `${fp.route} has no approach point yet.`
                  : route
                    ? `Route: ${route.join(" → ")} (${plural(route.length - 1, "connection")}). Uses only paths marked walkable.`
                    : `No walkable route from an entrance to ${fp.route}. Connect walk points to its approach point ${routeShelf.anchor}.`}
            </p>
          </section>

          <section aria-labelledby="fpub-h" className="flex flex-col gap-3 rounded-[26px] border-[1.5px] border-card bg-ivory p-[18px]">
            <H2 id="fpub-h">{fails.length ? `Before publishing: ${fails.length} to fix` : "Ready to publish"}</H2>
            <Checklist items={checks} />
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" className="text-[15px]" disabled={busy} onClick={save}>Save draft</Button>
              <Button className="text-[15px]" disabled={fails.length > 0 || busy} aria-describedby="fpub-h" onClick={() => setFp({ confirm: true })}>
                Publish
              </Button>
            </div>
            <p className="m-0 text-sm leading-[1.4] text-muted">
              {snap.maps.draftSavedAt ? `Draft saved ${fmt(snap.maps.draftSavedAt)}${fp.dirty ? ", with unsaved changes since" : ""}. ` : "Draft not saved yet. "}
              Shoppers and approvals use published v{pub.version} until you publish.
            </p>
          </section>
        </>
      )}

      <section aria-labelledby="fp-list-h" className="flex flex-col gap-2.5">
        <h2 id="fp-list-h" className="m-0 font-display text-[19px] font-normal text-indigo">Shelves and places (text list)</h2>
        <Field label="Find a shelf, aisle or product">
          <input type="search" value={fp.q} onChange={(e) => setFp({ q: e.target.value })} placeholder="e.g. Aisle 2 or oat milk" className={controlClass} />
        </Field>
        {!list.length && <p className="m-0 text-[15px]">No matching shelves on this plan.</p>}
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {list.map(({ r, c, ps, pend, hit }) => (
            <li key={r.key}>
              <button
                type="button"
                onClick={() => (isEdit ? setFp({ sel: { type: "shelf", key: r.key } }) : s.openShelf(r.id))}
                className="flex min-h-14 w-full items-center gap-2.5 rounded-[22px] border-[1.5px] border-card bg-ivory px-3.5 py-2.5 text-left text-charcoal"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-bold">Aisle {c.aisle} · Section {c.section}</span>
                  <span className="block text-sm leading-[1.35] text-muted">
                    {r.id} · {plural(ps.length, "verified product")}
                    {pend.length ? ` · ${plural(pend.length, "pending observation")}` : ""}
                    {hit.length ? " · Match: " + hit.map((p) => p.name).join(", ") : ""}
                  </span>
                </span>
                <span className={cx("flex-none rounded-full px-2.5 py-[3px] text-xs font-bold text-charcoal", pend.length ? "bg-warn" : "bg-tint")}>
                  {pend.length ? `◌ ${pend.length} pending` : "✓ Verified"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="m-0 text-sm leading-[1.45]">
          Entrances: {ents.join(", ") || "none"}. Help desk: {helps.join(", ") || "none"}. Landmarks:{" "}
          {m.landmarks.map((l) => `${l.id} ${l.label || "unnamed"} (${l.verified ? "verified" : "not verified"})`).join("; ") || "none"}. {m.edges.length} walkable connections.
        </p>
        {uncertainN > 0 && (
          <p className="m-0 rounded-[20px] bg-warn px-4 py-3 text-sm leading-[1.45]">
            <strong>? Uncertain locations:</strong> {uncertainN} pending observation{uncertainN === 1 ? " has" : "s have"} no exact shelf, so{" "}
            {uncertainN === 1 ? "it is" : "they are"} not shown on the plan.
          </p>
        )}
      </section>

      {fp.confirm && fp.draft && (
        <AlertDialog labelledBy="fpc-h" describedBy="fpc-b" onClose={() => !busy && setFp({ confirm: false })}>
          <h2 id="fpc-h" className="m-0 font-display text-[22px] font-normal text-indigo">Publish floor plan v{pub.version + 1}?</h2>
          <p id="fpc-b" className="m-0 text-[15px] leading-normal">
            Replaces v{pub.version} for shopper routes and employee approvals. {fp.draft.shelves.length} shelves, {fp.draft.nodes.length} walkable points and {fp.draft.edges.length} connections. Product locations keep their shelf IDs.
          </p>
          <div className="mt-1.5 flex gap-2.5">
            <Button variant="dark" className="flex-1 px-2" disabled={busy} onClick={() => setFp({ confirm: false })}>Cancel</Button>
            <Button className="flex-1 px-2" disabled={busy} onClick={publish}>{busy ? "Publishing…" : "Publish"}</Button>
          </div>
        </AlertDialog>
      )}
    </>
  );
}

export default withSnap(FloorPlanPage);
