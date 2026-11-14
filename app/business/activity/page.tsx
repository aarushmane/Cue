"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useSnap, withSnap } from "@/components/business/StaffProvider";
import { eventRow } from "@/components/business/derive";
import { BackLink, PageHeader } from "@/components/business/ui";

function ActivityPage() {
  const snap = useSnap();
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const events = snap.audit.map(eventRow);

  return (
    <>
      <PageHeader back={<BackLink onClick={() => router.push("/business/more")}>More</BackLink>} title="Store activity" sub="Append-only. Newest first." />
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {events.map((e) => {
          const on = open === e.id;
          return (
            <li key={e.id} className="overflow-hidden rounded-[26px] border-[1.5px] border-card bg-ivory">
              <button
                type="button"
                aria-expanded={on}
                aria-controls={`ev-${e.id}`}
                onClick={() => setOpen(on ? null : e.id)}
                className="flex w-full items-start gap-3 border-0 bg-transparent px-[18px] py-4 text-left text-charcoal"
              >
                <span aria-hidden="true" className="mt-[7px] size-2.5 flex-none rounded-full" style={{ background: e.dot }} />
                <span className="flex-1">
                  <span className="block text-base leading-[1.35] font-bold">{e.summary}</span>
                  <span className="mt-0.5 block text-sm text-muted">
                    {e.actor_label} · {e.when}
                  </span>
                </span>
                <span aria-hidden="true" className="text-xl leading-none text-indigo">{on ? "−" : "+"}</span>
              </button>
              {on && (
                <div id={`ev-${e.id}`}>
                  <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3.5 gap-y-1.5 px-[18px] pb-[18px] pl-10 text-sm">
                    <dt className="text-muted">Before</dt>
                    <dd className="m-0 font-semibold">{e.old_json.display}</dd>
                    <dt className="text-muted">After</dt>
                    <dd className="m-0 font-semibold">{e.new_json.display}</dd>
                    <dt className="text-muted">Evidence</dt>
                    <dd className="m-0 font-semibold">{e.evidence}</dd>
                  </dl>
                  {e.original_observation && (
                    <p className="m-0 px-[18px] pb-[18px] pl-10 text-sm leading-[1.4]">
                      <span className="block text-muted">Original observation</span>
                      <span className="font-semibold">{e.original_observation}</span>
                    </p>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

export default withSnap(ActivityPage);
