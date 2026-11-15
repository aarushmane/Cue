import { z } from "zod";
import { runVoiceAgent } from "@/lib/agents/voice/agent";
import { errorResponse, sceneFor, toStart, WayfindingBody } from "@/lib/wayfinding/request";
import { findInPhotos } from "@/lib/wayfinding/vision";
import { clientKey, createLimiter } from "@/lib/api/rateLimit";
import type { VoiceEvent } from "@/lib/voice/types";
import { sceneCatalog } from "@/lib/wayfinding/catalog";

export const maxDuration = 120;
const limiter = createLimiter(30, 60_000);
const Body = WayfindingBody.extend({
  query: z.string().trim().min(1).max(300),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) })).max(8).default([]),
  current_item_id: z.string().max(100).optional(),
  clarification: z.object({ options: z.array(z.string().trim().min(1).max(200)).min(1).max(4) }).optional(),
  heading_deg: z.number().finite().min(-360).max(360).optional(),
  speed_mps: z.number().finite().min(0).max(100).optional(),
  walking_speed_mps: z.number().finite().min(0.4).max(1.8).optional(),
  session_id: z.string().regex(/^[a-f0-9]{32}$/).optional(),
});

export async function POST(request: Request) {
  if (!limiter.hit(clientKey(request)).ok) return Response.json({ error: "Too many scene requests." }, { status: 429 });
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid voice request." }, { status: 400 });
  const body = parsed.data;
  const aborted = new AbortController();
  const signal = AbortSignal.any([request.signal, aborted.signal]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: VoiceEvent | { type: "result"; data: unknown } | { type: "error"; error: string }) => {
        if (!signal.aborted) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        send({ type: "progress", stage: "loading", label: "Loading scene" });
        const base = await sceneFor(body);
        const catalog = await sceneCatalog(base).catch(() => []);
        const known = new Set(base.items.map((item) => item.id));
        const scene = { ...base, items: [...base.items, ...catalog.filter((item) => !known.has(item.id))] };
        signal.throwIfAborted();
        const result = await runVoiceAgent(scene, {
          query: body.query, start: toStart(body.start, scene), history: body.history, currentItemId: body.current_item_id, clarification: body.clarification,
          signal, searchPhotos: (query) => findInPhotos(scene, query), headingDeg: body.heading_deg, speedMps: body.speed_mps, walkingSpeedMps: body.walking_speed_mps, onEvent: send,
          getPosition: body.session_id ? async () => {
            const base = process.env.VOICE_BACKEND_URL || process.env.NEXT_PUBLIC_BACKEND_URL || "http://127.0.0.1:8000";
            try {
              const response = await fetch(new URL(`/voice/state/${body.session_id}`, base), { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), cache: "no-store" });
              const state = response.ok ? await response.json() : null;
              return state?.model_id === body.model_id ? state : null;
            } catch { signal.throwIfAborted(); return null; }
          } : undefined,
        });
        send({ type: "result", data: result });
      } catch (error) {
        if (!signal.aborted) {
          const response = errorResponse(error);
          const failure = await response.json();
          send({ type: "error", error: failure.error || "Could not plan the route. Try again." });
        }
      } finally { if (!signal.aborted) controller.close(); }
    },
    cancel() { aborted.abort(); },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson", "content-encoding": "identity", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
