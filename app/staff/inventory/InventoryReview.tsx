"use client";
// Staff inventory: the published list (with "last seen by shoppers") and the review queue of changes
// suggested by shopper camera sightings. Nothing reaches the list until staff approve it here.
import { useCallback, useEffect, useState } from "react";

type Level = "top" | "upper" | "middle" | "lower" | "bottom";
interface Item {
  product_id: string; name: string; brand: string | null; variant: string | null; size: string | null; category: string | null;
  shelf_id: string; aisle: string; section: string; level: Level | null; verified_at: string; last_seen_at: string | null; miss_count: number;
}
interface Suggestion {
  id: string; kind: "NEW_PRODUCT" | "MOVED" | "MISSING"; status: string; product_id: string | null;
  proposed: { name: string; brand: string | null; variant: string | null; size: string | null; category: string | null };
  shelf_counts: Record<string, number>; sighting_count: number; threshold: number; evidence: string[]; last_seen_at: string;
}

const KIND_LABEL = { NEW_PRODUCT: "New item", MOVED: "Moved", MISSING: "Possibly gone" } as const;
const KIND_STYLE = {
  NEW_PRODUCT: "bg-emerald-100 text-emerald-900 dark:bg-emerald-900/40 dark:text-emerald-100",
  MOVED: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100",
  MISSING: "bg-rose-100 text-rose-900 dark:bg-rose-900/40 dark:text-rose-100",
} as const;

function ago(iso: string | null): string {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
const title = (p: { name: string; brand: string | null; size: string | null }) => [p.brand, p.name, p.size].filter(Boolean).join(" · ");
const shelfName = (id: string) => id.replace(/^S-A(\w+)-(\w+)$/, "Aisle $1, section $2");

export function InventoryReview() {
  const [storeId, setStoreId] = useState("demo-store");
  const [token, setToken] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [queue, setQueue] = useState<Suggestion[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  const load = useCallback(async () => {
    if (!token) return;
    const headers = { authorization: `Bearer ${token}` };
    const [inv, sug] = await Promise.all([
      fetch(`/api/inventory?store_id=${encodeURIComponent(storeId)}`, { headers }),
      fetch(`/api/inventory/suggestions?store_id=${encodeURIComponent(storeId)}&status=PENDING`, { headers }),
    ]);
    if (!inv.ok || !sug.ok) {
      setError((await (inv.ok ? sug : inv).json().catch(() => ({}))).error ?? "Could not load inventory.");
      return;
    }
    setError(null);
    setItems((await inv.json()).items);
    setQueue((await sug.json()).suggestions);
  }, [storeId, token]);

  useEffect(() => {
    const first = setTimeout(load, 0);
    const t = setInterval(load, 10_000); // adaptive: new sightings show up without a reload
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [load]);

  async function review(s: Suggestion, action: "approve" | "reject", form?: FormData) {
    const body: Record<string, unknown> = { action };
    if (action === "approve" && form) {
      if (form.get("shelf_id")) body.shelf_id = form.get("shelf_id");
      if (form.get("level")) body.level = form.get("level");
      if (s.kind === "NEW_PRODUCT") {
        const edits: Record<string, string | null> = {};
        for (const k of ["name", "brand", "variant", "size", "category"] as const) {
          const v = String(form.get(k) ?? "").trim();
          edits[k] = v || null;
        }
        if (!edits.name) { setStatus("A product name is required."); return; }
        body.edits = edits;
      }
    }
    const res = await fetch(`/api/inventory/suggestions/${s.id}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const out = await res.json().catch(() => ({}));
    setStatus(res.ok ? `${action === "approve" ? "Approved" : "Rejected"}: ${title(s.proposed)}` : out.error ?? "Failed.");
    load();
  }

  const shelves = [...new Set(items.map((i) => i.shelf_id))].sort();

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-8 text-zinc-900 dark:text-zinc-100">
      <h1 className="text-2xl font-semibold">Inventory</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Shopper cameras suggest changes; nothing is added, moved or removed until you approve it.
      </p>

      <form
        className="mt-4 flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const t = String(f.get("token") ?? "");
          setStoreId(String(f.get("store") ?? "demo-store"));
          setToken(t);
        }}
      >
        <label className="flex flex-col text-sm">Store
          <input name="store" defaultValue={storeId} className="mt-1 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700" />
        </label>
        <label className="flex flex-col text-sm">Staff token
          <input name="token" type="password" defaultValue={token} className="mt-1 rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700" />
        </label>
        <button className="rounded bg-zinc-900 px-3 py-1.5 text-sm text-white dark:bg-zinc-100 dark:text-zinc-900">Load</button>
      </form>

      {error && <p role="alert" className="mt-4 text-sm text-rose-700 dark:text-rose-300">{error}</p>}
      <p aria-live="polite" className="mt-2 min-h-5 text-sm text-zinc-600 dark:text-zinc-400">{status}</p>

      <section aria-labelledby="queue-h" className="mt-4">
        <h2 id="queue-h" className="text-lg font-semibold">Needs review ({queue.length})</h2>
        {queue.length === 0 && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">Nothing to review.</p>}
        <ul className="mt-3 grid gap-3">
          {queue.map((s) => {
            const shelfOptions = Object.entries(s.shelf_counts).sort((a, b) => b[1] - a[1]);
            return (
              <li key={s.id} className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
                <form onSubmit={(e) => { e.preventDefault(); review(s, "approve", new FormData(e.currentTarget)); }}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${KIND_STYLE[s.kind]}`}>{KIND_LABEL[s.kind]}</span>
                    <span className="font-medium">{title(s.proposed)}</span>
                    {s.proposed.category && <span className="text-sm text-zinc-500">{s.proposed.category}</span>}
                    <span className="ml-auto text-xs text-zinc-500">{s.sighting_count} sighting{s.sighting_count === 1 ? "" : "s"} · last {ago(s.last_seen_at)}</span>
                  </div>
                  {s.evidence[0] && <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">“{s.evidence[0]}”</p>}

                  {s.kind === "NEW_PRODUCT" && (
                    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                      {(["name", "brand", "variant", "size", "category"] as const).map((k) => (
                        <label key={k} className="flex flex-col text-xs capitalize">{k}
                          <input name={k} defaultValue={s.proposed[k] ?? ""} className="mt-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700" />
                        </label>
                      ))}
                    </div>
                  )}

                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    {s.kind !== "MISSING" ? (
                      <>
                        <label className="flex flex-col text-xs">Shelf
                          <select name="shelf_id" className="mt-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700">
                            {shelfOptions.map(([id, n]) => <option key={id} value={id}>{shelfName(id)} ({n})</option>)}
                          </select>
                        </label>
                        <label className="flex flex-col text-xs">Level
                          <select name="level" defaultValue="" className="mt-1 rounded border border-zinc-300 bg-transparent px-2 py-1 text-sm dark:border-zinc-700">
                            <option value="">Unknown</option>
                            {["top", "upper", "middle", "lower", "bottom"].map((l) => <option key={l} value={l}>{l}</option>)}
                          </select>
                        </label>
                      </>
                    ) : (
                      <p className="text-sm">Approving removes it from what shoppers can find, on {shelfName(shelfOptions[0]?.[0] ?? "")}.</p>
                    )}
                    <button className="ml-auto rounded bg-emerald-700 px-3 py-1.5 text-sm text-white">Approve</button>
                    <button type="button" onClick={() => review(s, "reject")} className="rounded border border-zinc-300 px-3 py-1.5 text-sm dark:border-zinc-700">Reject</button>
                  </div>
                </form>
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="inv-h" className="mt-8">
        <h2 id="inv-h" className="text-lg font-semibold">Published inventory ({items.length})</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase text-zinc-500">
              <tr><th className="py-2 pr-3">Product</th><th className="pr-3">Type</th><th className="pr-3">Location</th><th className="pr-3">Level</th><th className="pr-3">Last seen by shoppers</th></tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.product_id} className="border-t border-zinc-200 dark:border-zinc-800">
                  <td className="py-2 pr-3">{title(i)}{i.variant ? <span className="text-zinc-500"> ({i.variant})</span> : null}</td>
                  <td className="pr-3 text-zinc-600 dark:text-zinc-400">{i.category ?? "—"}</td>
                  <td className="pr-3">Aisle {i.aisle}, section {i.section}</td>
                  <td className="pr-3">{i.level ?? "—"}</td>
                  <td className="pr-3">{ago(i.last_seen_at)}{i.miss_count > 0 && <span className="ml-2 text-rose-700 dark:text-rose-300">not seen in {i.miss_count} scan{i.miss_count === 1 ? "" : "s"}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {shelves.length === 0 && token && !error && <p className="mt-2 text-sm text-zinc-600">No published items.</p>}
      </section>
    </main>
  );
}
