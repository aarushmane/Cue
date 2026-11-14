import { z } from "zod";
import { Candidate } from "@/lib/demo/schemas";
import { submitShopperObservation } from "@/lib/staff/service";

const Body = z.object({
  store_id: z.string().min(1).max(100),
  consent: z.literal("allowed"),
  confidence: z.enum(["High", "Medium", "Low"]),
  evidence: z.string().max(300),
  candidate: Candidate,
});

// POST /api/observations — a consented shopper observation. Structured text only: no image, no shopper identity.
// Nothing reaches shoppers until staff approve it in Review. An identical pending one gains a sighting instead.
export async function POST(request: Request) {
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
