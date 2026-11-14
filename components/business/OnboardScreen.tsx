"use client";
// Store onboarding: staff enter a CoStar property id (or Matterport model id), the onboarding deep agent imports
// the digital twin, and this screen shows its plan (to-dos), the draft walkable graph over the floor plan, and
// the product suggestions it queued. The result is a DRAFT: nothing reaches shoppers until staff publish.
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Circle, CircleDot } from "lucide-react";
import type { OnboardingResult } from "@/lib/agents/onboarding/agent";
import { asTodos, streamOnboarding, todoAnnouncement, toolLabel, type Todo } from "@/lib/agents/onboarding/progress";
import { runOnboardingDemo } from "@/lib/demo/onboard";
import { DraftGraphMap } from "@/components/map/DraftGraphMap";
import { MiniMarkdown } from "./MiniMarkdown";
import { BackLink, Button, Card, controlClass, DemoTag, H2, ICON, PageHeader } from "./ui";
import { useRouter } from "next/navigation";

const PRESETS = [
  { id: "fixture-property-1", label: "Fixture store (no keys needed)" },
  { id: "9560712", label: "337 S Broadway, LA (CoStar)" },
  { id: "bP9oEnqmeie", label: "941 Towne Ave, LA (Matterport)" },
];

function PlanList({ todos }: { todos: Todo[] }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-2 p-0">
      {todos.map((t, i) => {
        const Icon = t.status === "completed" ? CheckCircle2 : t.status === "in_progress" ? CircleDot : Circle;
        return (
          <li key={i} className="flex items-start gap-2.5 rounded-[18px] bg-ivory px-3.5 py-2.5 text-[15px]">
            <Icon size={20} className="mt-0.5 flex-none text-indigo" {...ICON} />
            <span>
              {t.content}
              <span className="sr-only"> ({t.status.replace("_", " ")})</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function OnboardScreen() {
  const router = useRouter();
  const [id, setId] = useState(PRESETS[0].id);
  const [result, setResult] = useState<OnboardingResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [showPlan, setShowPlan] = useState(true);
  // Live progress while the run streams.
  const [liveTodos, setLiveTodos] = useState<Todo[]>([]);
  const [now, setNow] = useState("");
  const [live, setLive] = useState(true);
  const [announcement, setAnnouncement] = useState("");
  const todosRef = useRef<Todo[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const status = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (!busy) return;
    const t0 = Date.now();
    const iv = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000);
    return () => clearInterval(iv);
  }, [busy]);

  // Leaving the screen closes the stream, which stops the run on the server.
  useEffect(() => () => abortRef.current?.abort(), []);

  const run = async () => {
    if (busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setBusy(true);
    setError("");
    setResult(null);
    setElapsed(0);
    setLiveTodos([]);
    setNow("");
    setLive(true);
    setAnnouncement("");
    todosRef.current = [];
    try {
      const out = await streamOnboarding(
        { costar_property_id: id },
        {
          signal: ac.signal,
          onEvent: (e) => {
            if (e.type === "todos") {
              // At most one polite announcement per plan change, and only when a step started or finished.
              const msg = todoAnnouncement(todosRef.current, e.todos);
              todosRef.current = e.todos;
              setLiveTodos(e.todos);
              if (msg) setAnnouncement(msg);
            } else if (e.type === "tool") {
              setNow(toolLabel(e.name)); // visual only: tool calls are too frequent to announce
            }
          },
        },
      );
      if (out.kind === "result") setResult(out.result);
      else if (out.kind === "error") setError(out.error);
      else {
        // No stream (e.g. an older server): the Server Function still works, just without live progress.
        setLive(false);
        setNow("");
        const r = await runOnboardingDemo(id);
        if (r.ok) setResult(r.result);
        else setError(r.error);
      }
    } catch {
      if (ac.signal.aborted) return; // unmounted
      setError("Onboarding failed unexpectedly. Try again.");
    } finally {
      if (!ac.signal.aborted) {
        setBusy(false);
        setNow("");
        status.current?.focus();
      }
    }
  };

  const todos = result ? asTodos(result.todos) : liveTodos;
  const v = result?.view;
  const g = v?.graph ?? null;

  return (
    <>
      <PageHeader
        back={<BackLink onClick={() => router.push("/business/more")}>More</BackLink>}
        title="Onboard a store"
        sub="Turn a CoStar property's digital twin into a draft navigation map. Staff review everything before shoppers see it."
      />

      <Card className="flex flex-col gap-3">
        <label htmlFor="ob-id" className="text-[15px] font-bold">CoStar property id or Matterport model id</label>
        <input id="ob-id" value={id} onChange={(e) => setId(e.target.value)} autoComplete="off" className={controlClass} />
        <div role="group" aria-label="Example properties" className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={id === p.id}
              onClick={() => setId(p.id)}
              className={`min-h-11 rounded-full border-2 px-3.5 text-sm font-bold ${id === p.id ? "border-indigo bg-indigo text-white" : "border-control bg-ivory text-charcoal"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
        <Button onClick={run} aria-disabled={busy || undefined} className="self-start">
          {busy ? `Running… ${elapsed}s` : "Run onboarding agent"}
        </Button>
        <DemoTag />
      </Card>

      <p ref={status} tabIndex={-1} role="status" className={`m-0 text-[15px] font-semibold outline-none ${error ? "text-err" : ""}`}>
        {busy
          ? "The agent is planning, importing the twin and building the graph. This usually takes one to three minutes."
          : error || (result ? `Done. Draft ${result.draft_id ?? "(not saved)"} from ${result.source === "costar" ? "CoStar data" : "fixture data"}.` : "")}
      </p>
      {/* Plan progress for screen readers: text changes only when a step starts or finishes (see todoAnnouncement). */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {busy ? announcement : ""}
      </p>

      {busy && (
        <section aria-labelledby="ob-live-h" className="flex flex-col gap-2.5">
          <H2 id="ob-live-h">Agent plan</H2>
          {live ? (
            <p className="m-0 text-[15px]">
              <span className="font-bold">Now:</span> {now || "Starting the agent…"}
            </p>
          ) : (
            <p className="m-0 text-[15px] text-muted">Live progress isn&apos;t available; the plan will appear when the run finishes.</p>
          )}
          {liveTodos.length > 0 && <PlanList todos={liveTodos} />}
        </section>
      )}

      {result && (
        <>
          <Card className="flex flex-col gap-2">
            <div className="flex flex-col items-start gap-2">
              <H2>{v?.property?.name ?? "Property"}</H2>
              <span className={`rounded-full px-3 py-1 text-[13px] font-bold ${result.source === "costar" ? "bg-indigo text-white" : "bg-warn"}`}>
                {result.source === "costar" ? "Real CoStar data" : "Fixture data"}
              </span>
            </div>
            {v?.property && (
              <p className="m-0 text-[15px] text-muted">
                {v.property.address}
                {v.property.property_type ? ` · ${v.property.property_type}` : ""}
                {v.property.matterport_model_id ? ` · Matterport ${v.property.matterport_model_id}` : ""}
              </p>
            )}
            {result.graph_summary && (
              <ul className="m-0 flex list-none flex-wrap gap-2 p-0 text-sm font-semibold">
                <li className="rounded-full bg-tint px-3 py-1">{result.graph_summary.nodes} points</li>
                <li className="rounded-full bg-tint px-3 py-1">{result.graph_summary.edges} paths</li>
                <li className="rounded-full bg-tint px-3 py-1">
                  {result.graph_summary.components === 1 ? "Fully connected" : `${result.graph_summary.components} disconnected parts`}
                </li>
                {g && <li className="rounded-full bg-tint px-3 py-1">Edges: {g.edge_source === "neighbors" ? "Matterport navigation links" : "proximity (wall-checked)"}</li>}
              </ul>
            )}
          </Card>

          {v?.aerial && (
            <section aria-labelledby="ob-aerial-h" className="flex flex-col gap-2.5">
              <div className="flex flex-col items-start gap-2">
                <H2 id="ob-aerial-h">Approach from outside</H2>
                <span className="rounded-full bg-warn px-3 py-1 text-[13px] font-bold">Needs staff confirmation</span>
              </div>
              <p className="m-0 rounded-[18px] bg-ivory px-3.5 py-2.5 text-[15px]">{v.aerial.notes}</p>
              <p className="m-0 text-sm text-muted">
                Read from an overhead photo, not a site visit. Walk the approach from the street and confirm the entrance side, parking and
                drop-off before publishing.
              </p>
            </section>
          )}

          <section aria-labelledby="ob-plan-h" className="flex flex-col gap-2.5">
            <H2 id="ob-plan-h">Agent plan</H2>
            {todos.length ? (
              <PlanList todos={todos} />
            ) : (
              <p className="m-0 text-[15px] text-muted">The agent did not record a plan.</p>
            )}
          </section>

          {g && (
            <section aria-labelledby="ob-map-h" className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-2">
                <H2 id="ob-map-h">Draft walkable graph{g.floor_label ? ` · ${g.floor_label}` : ""}</H2>
                {g.plan && (
                  <label className="flex items-center gap-2 text-sm font-semibold">
                    <input type="checkbox" checked={showPlan} onChange={(e) => setShowPlan(e.target.checked)} className="size-5" />
                    Floor plan
                  </label>
                )}
              </div>
              <DraftGraphMap graph={g} showPlan={showPlan} />
              <p className="m-0 text-sm text-muted">
                {Math.round(g.width_m)} × {Math.round(g.height_m)} m. Gold dots are the entrance, outlined dots are landmark scan points used to find
                shoppers. {g.plan ? "The plan is aligned from Matterport's origin and scale; check it visually." : "No floor plan image came with this model."}
              </p>
            </section>
          )}

          <section aria-labelledby="ob-cand-h" className="flex flex-col gap-2.5">
            <H2 id="ob-cand-h">Product suggestions ({result.candidates_queued})</H2>
            {v?.candidates.length ? (
              <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
                {v.candidates.map((c, i) => (
                  <li key={i} className="flex justify-between gap-2 rounded-[14px] bg-ivory px-3.5 py-2 text-[15px]">
                    <span>{[c.brand, c.name].filter(Boolean).join(" ")}</span>
                    <span className="text-muted">{c.confidence}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="m-0 text-[15px] text-muted">No shelf products were recognized in this run.</p>
            )}
            <p className="m-0 text-sm text-muted">
              Suggestions are saved with the draft as NEEDS_REVIEW. Approve products in <Link href="/business/review" className="font-bold text-indigo">Review</Link>.
            </p>
          </section>

          <section aria-labelledby="ob-report-h" className="flex flex-col gap-2">
            <H2 id="ob-report-h">Agent report</H2>
            <MiniMarkdown text={result.report} />
            <details className="text-sm">
              <summary className="min-h-11 cursor-pointer py-2 font-bold text-indigo">Tool calls ({result.tool_calls.length})</summary>
              <ol className="m-0 pl-5">
                {result.tool_calls.map((t, i) => (
                  <li key={i}>{t}</li>
                ))}
              </ol>
            </details>
          </section>
        </>
      )}
    </>
  );
}
