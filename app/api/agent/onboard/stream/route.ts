import { runOnboardingStream } from "@/lib/agents/onboarding/agent";
import { encodeEvent, type OnboardEvent } from "@/lib/agents/onboarding/progress";
import { acquireOnboardingLock, BUSY, checkOnboardingRequest, onboardingFailure } from "@/lib/demo/onboard-guard";

// A run takes one to three minutes.
export const maxDuration = 300;

/**
 * POST /api/agent/onboard/stream — the staff onboarding screen's live view of a run. Same rules as the
 * runOnboardingDemo Server Function: memory mode only, no staff session (demo), ONBOARD_PASSCODE when set, one run
 * at a time (429 BUSY). Body: { costar_property_id, store_id?, passcode? }.
 *
 * Refusals (Supabase configured, no AI provider, invalid input) are plain JSON with an HTTP status, before any
 * streaming. Otherwise the response is Server-Sent Events: {type:"todos"} and {type:"tool"} while the agent works,
 * then exactly one {type:"result", result: OnboardingResult} or {type:"error"}. Closing the connection stops the run.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { costar_property_id?: unknown; store_id?: unknown; passcode?: unknown } | null;
  const req = checkOnboardingRequest(body?.costar_property_id, body?.store_id ?? undefined, body?.passcode);
  if (!req.ok) return Response.json(req, { status: req.status });
  const release = acquireOnboardingLock();
  if (!release) return Response.json(BUSY, { status: BUSY.status });

  const encoder = new TextEncoder();
  const cancelled = new AbortController();
  const signal = AbortSignal.any([request.signal, cancelled.signal]);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let open = true;
      const write = (text: string) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          open = false; // client went away
        }
      };
      const send = (e: OnboardEvent) => write(encodeEvent(e));
      // Comment lines keep idle proxies from closing the connection during long model calls.
      const ping = setInterval(() => write(": ping\n\n"), 15_000);
      write(": started\n\n");
      try {
        const result = await runOnboardingStream(req.propertyId, null, { store_id: req.storeId }, { onEvent: send, signal });
        send({ type: "result", result });
      } catch (err) {
        send({ type: "error", error: signal.aborted ? "The run was stopped." : onboardingFailure(err).error });
      } finally {
        clearInterval(ping);
        release();
        open = false;
        try {
          controller.close();
        } catch {
          // already closed by a cancel
        }
      }
    },
    cancel() {
      cancelled.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
