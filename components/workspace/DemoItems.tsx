"use client";

import { useEffect, useState } from "react";
import { Info, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type CatalogItem = { name: string; category?: string };
type Group = { category: string; names: string[] };

/** One entry per product name, grouped by category, so visitors know what this demo store can find. */
function groupItems(items: CatalogItem[]): Group[] {
  const groups = new Map<string, Set<string>>();
  for (const item of items) {
    const category = item.category?.trim() || "other";
    if (!groups.has(category)) groups.set(category, new Set());
    groups.get(category)!.add(item.name.trim());
  }
  return [...groups].map(([category, names]) => ({ category, names: [...names].sort((a, b) => a.localeCompare(b)) }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

export function DemoItems({ modelId, onPick }: { modelId: string; onPick: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || groups) return;
    const abort = new AbortController();
    fetch(`/api/wayfinding/catalog?${new URLSearchParams({ model_id: modelId })}`, { signal: abort.signal })
      .then(async (response) => {
        const data = await response.json() as { items?: CatalogItem[]; error?: string; message?: string };
        if (!response.ok) throw new Error(data.message ?? data.error ?? "Could not load items.");
        setGroups(groupItems(data.items ?? []));
        setError("");
      })
      .catch((reason: unknown) => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load items."); });
    return () => abort.abort();
  }, [open, groups, modelId]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild><Button variant="ghost" size="icon" className="size-11" aria-label="Items in this store"><Info className="size-4" aria-hidden="true" /></Button></PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>Items in this store</TooltipContent>
      </Tooltip>
      <PopoverContent side="bottom" align="end" sideOffset={10} className="w-[304px] max-w-[calc(100vw-24px)] gap-3 p-4" aria-label="Items in this store">
        <h2 className="m-0 text-sm font-medium">Items you can look up</h2>
        <div className="max-h-[50svh] overflow-y-auto pr-1">
          {!groups && !error && <LoaderCircle className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" aria-label="Loading items" />}
          {error && <p className="m-0 text-xs text-destructive" role="status">{error}</p>}
          {groups?.length === 0 && <p className="m-0 text-xs text-muted-foreground">No items found in this scan yet.</p>}
          {groups?.map((group) => (
            <section key={group.category} className="mb-3 last:mb-0">
              <h3 className="m-0 mb-1 text-label capitalize text-muted-foreground">{group.category}</h3>
              <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                {group.names.map((name) => (
                  <li key={name}>
                    <Button variant="secondary" size="sm" className="h-7 px-2 text-xs" onClick={() => { onPick(name); setOpen(false); }}>{name}</Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
