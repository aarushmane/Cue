import { z } from "zod";
import { clientKey, createLimiter } from "@/lib/api/rateLimit";
import { Candidate } from "@/lib/demo/schemas";
import { parseStatuses, readObservations } from "@/lib/staff/reads";
import { json, staffForStoreParam } from "@/lib/staff/readRoute";
import { submitShopperObservation } from "@/lib/staff/service";

const Body = z.object({
  store_id: z.string().min(1).max(100),
  consent: z.literal("allowed"),
  confidence: z.enum(["High", "Medium", "Low"]),
  evidence: z.string().max(300),
  candidate: Candidate,
});

// Unauthenticated, so damp abuse: OBSERVATION_RATE_LIMIT submissions per minute per client address (default 20).
const limiter = createLimiter(Number(process.env.OBSERVATION_RATE_LIMIT) || 20, 60_000);

// POST /api/observations — a consented shopper observation. Structured text only: no image, no shopper identity.
// Nothing reaches shoppers until staff approve it in Review. An identical pending one gains a sighting instead.
export async function POST(request: Request) {
  const rl = limiter.hit(clientKey(request));
  if (!rl.ok) {
    return Response.json(
      { code: "RATE_LIMITED", error: "Too many submissions from this device. Try again in a minute." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfter) } },
    );
  }
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const noConsent = parsed.error.issues.some((i) => i.path[0] === "consent");
    return noConsent
      ? Response.json({ code: "NO_CONSENT", error: "Product contributions are not allowed, so nothing was sent." }, { status: 403 })
      : Response.json({ code: "BAD_REQUEST", issues: parsed.error.issues.slice(0, 3) }, { status: 400 });
  }
  const { store_id, confidence, evidence, candidate } = parsed.data;
  const out = await submitShopperObservation(store_id, confidence, evidence, candidate);
  return Response.json(out.body, { status: out.status });
}

// GET /api/observations?store_id=&status=NEEDS_REVIEW[,NEEDS_RESCAN,…] — staff only. Newest first.
export async function GET(request: Request) {
  const ctx = await staffForStoreParam(request);
  if (ctx instanceof Response) return ctx;
  let statuses;
  try {
    statuses = parseStatuses(new URL(request.url).searchParams.get("status"));
  } catch (err) {
    return json({ code: "BAD_REQUEST", error: (err as Error).message }, 400);
  }
  try {
    return json({ observations: await readObservations(ctx.storeId, statuses) });
  } catch {
    return json({ code: "DB_ERROR", error: "The database request failed. Try again." }, 500);
  }
}
