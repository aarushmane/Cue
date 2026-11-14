"use client";
import { useRouter } from "next/navigation";
import { candLoc, SRC, STATUS_MARK, STATUS_TXT, titleOf } from "@/lib/review/format";
import { findMatches } from "@/lib/review/matches";
import { draftFromObservation, validate } from "@/lib/review/validate";
import { useSnap, useStaff } from "./StaffProvider";
import { pendingObs, reviewedObs } from "./derive";
import { BackLink, PageHeader, Pill } from "./ui";

export function ReviewQueue() {
  const snap = useSnap();
  const s = useStaff();
  const router = useRouter();
  const pending = pendingObs(snap);
  const reviewed = reviewedObs(snap);
  const list = s.rTab === "pending" ? pending : reviewed;

  return (
    <>
      <PageHeader
        back={<BackLink onClick={() => router.push("/business/more")}>More</BackLink>}
        title="Review observations"
        sub="Shopper sightings and AI suggestions. Nothing is published until you approve it."
      />
      <div role="group" aria-label="Observation queue" className="grid grid-cols-2 gap-2">
        <Pill on={s.rTab === "pending"} onClick={() => s.setRTab("pending")} className="min-h-12 text-[15px]">
          Pending ({pending.length})
        </Pill>
        <Pill on={s.rTab === "reviewed"} onClick={() => s.setRTab("reviewed")} className="min-h-12 text-[15px]">
          Reviewed ({reviewed.length})
        </Pill>
      </div>
      {!list.length && (
        <p className="m-0 rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-4 text-[15px]">
          {s.rTab === "pending" ? "No observations waiting. New shopper sightings and AI suggestions appear here." : "Nothing reviewed yet."}
        </p>
      )}
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {list.map((o) => {
          const c = o.candidate;
          let note = "";
          if (o.status === "NEEDS_REVIEW") {
            const d = s.drafts[o.id] ?? draftFromObservation(o);
            const ch = validate(o, d, snap.products, snap.maps.published);
            const need: string[] = [];
            if (!ch[0].ok) need.push("missing details");
            if (!ch[3].ok) need.push("no exact shelf");
            if (findMatches(d, snap.products, o.suggestedMatch).length) need.push("possible existing product");
            note = (o.saved ? "Details saved, not published. " : "") + (need.length ? "Check: " + need.join(", ") + "." : "");
          } else {
            note = `By ${o.reviewedBy}${o.reason ? ". Reason: " + o.reason : ""}`;
          }
          return (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => s.setReviewId(o.id)}
                aria-label={`${titleOf(c)}. ${SRC[o.source]}. ${candLoc(c)}. ${STATUS_TXT[o.status]}. ${note}`}
                className="flex w-full flex-col gap-1.5 rounded-[26px] border-[1.5px] border-card bg-ivory px-[18px] py-4 text-left text-charcoal"
              >
                <span className="flex flex-wrap gap-1.5">
                  <span className={`rounded-full px-2.5 py-1 text-[13px] font-bold text-charcoal ${o.source === "shopper" ? "bg-tint" : "bg-warn"}`}>
                    {SRC[o.source]}
                  </span>
                  <span className="rounded-full bg-lavender px-2.5 py-1 text-[13px] font-bold text-indigo">
                    {STATUS_MARK[o.status]} {STATUS_TXT[o.status]}
                  </span>
                </span>
                <strong className="text-[17px] leading-[1.3]">{titleOf(c)}</strong>
                <span className="text-sm text-muted">
                  {o.id} · {candLoc(c)}
                </span>
                {note && <span className="text-sm leading-[1.4] font-semibold">{note}</span>}
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}
