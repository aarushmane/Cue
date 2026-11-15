// Onboarding agent tools (LangChain `tool` + zod). They call deterministic code and record results on the run.
// None of them can publish a map or a product location — the final step only saves a DRAFT for staff review.
import { tool } from "langchain";
import { z } from "zod";
import { sweepsToGraph } from "../../twin/sweepsToGraph";
import { recognizeShelf } from "../../vision/recognizeShelf";
import { analyzeAerial } from "../../vision/aerial";
import { aiConfigured } from "../../ai/provider";
import { queueAiObservations, saveDraft } from "../../db/writes";
import { logEvent, type OnboardingRun } from "./run-context";

const json = (v: unknown) => JSON.stringify(v);

export function onboardingTools(run: OnboardingRun) {
  const lookupProperty = tool(
    async ({ property_id }) => {
      const p = await run.layers.lookupProperty(property_id);
      logEvent(run, "lookup_property", { property_id, found: Boolean(p) });
      if (!p) return json({ error: "PROPERTY_NOT_FOUND" });
      run.property = p;
      return json({ source: run.layers.source, property: p });
    },
    {
      name: "lookup_property",
      description: "Look up a building in CoStar: name, address, coordinates, property type, tenants and linked Matterport model id.",
      schema: z.object({ property_id: z.string() }),
    },
  );

  const fetchTwin = tool(
    async ({ model_id }) => {
      const twin = await run.layers.getTwin(model_id);
      logEvent(run, "fetch_twin", { model_id, found: Boolean(twin) });
      if (!twin) return json({ error: "MODEL_NOT_FOUND" });
      run.twin = twin;
      const rooms = twin.rooms ?? {};
      const perFloor = twin.floors.map((f) => {
        const onFloor = twin.sweeps.filter((s) => s.floorId === f.id);
        const roomCounts: Record<string, number> = {};
        for (const s of onFloor) if (rooms[s.id]) roomCounts[rooms[s.id]] = (roomCounts[rooms[s.id]] ?? 0) + 1;
        return { ...f, sweeps: onFloor.length, walls: twin.walls?.[f.id]?.length ?? 0, rooms: roomCounts };
      });
      // Scan points in entry-like rooms are the best entrance candidates (Matterport room classification).
      const entranceCandidates = twin.sweeps
        .filter((s) => /entry|foyer|lobby|vestibule|reception|storefront/i.test(rooms[s.id] ?? ""))
        .slice(0, 6)
        .map((s) => ({ sweep_id: s.id, floor_id: s.floorId, room: rooms[s.id] }));
      return json({
        source: run.layers.source,
        floors: perFloor,
        sweeps_with_neighbor_data: twin.sweeps.filter((s) => s.neighbors?.length).length,
        panoramas: twin.panoramas.length,
        has_floor_plan_image: Boolean(twin.floorPlanImageUrl),
        entrance_candidates: entranceCandidates,
      });
    },
    {
      name: "fetch_twin",
      description: "Load the Matterport digital twin: floors, scan points (sweeps) and panoramas. Returns a summary.",
      schema: z.object({ model_id: z.string() }),
    },
  );

  const inspectAerial = tool(
    async () => {
      if (!run.property) return json({ error: "Call lookup_property first." });
      const a = await run.layers.getAerial(run.property.latitude, run.property.longitude);
      // The image stays server-side; only the vision model's structured reading goes back into agent context.
      const analysis =
        a?.imageDataUrl && aiConfigured()
          ? await analyzeAerial(a.imageDataUrl, { name: run.property.name, address: run.property.address, extentM: a.extentM }).catch(() => null)
          : null;
      run.aerialNotes = [a?.notes, analysis && `Entrance likely faces ${analysis.entrance_side} (${analysis.confidence}). Parking: ${analysis.parking}. Approach: ${analysis.approach_notes}`]
        .filter(Boolean)
        .join(" ");
      logEvent(run, "inspect_aerial", { has_image: Boolean(a?.imageDataUrl), analysis });
      return json({
        source: run.layers.source,
        notes: a?.notes ?? "No aerial view.",
        analysis,
        caveat: "The Matterport model frame is not north-aligned, so the entrance side cannot be mapped to a scan point automatically. Prefer entrance_candidates from fetch_twin; otherwise pass null.",
      });
    },
    {
      name: "inspect_aerial",
      description: "Read the Vexcel aerial photo of the property with vision: which side the public entrance faces, parking/drop-off, and the walking approach.",
      schema: z.object({}),
    },
  );

  const buildDraftGraph = tool(
    async ({ floor_id, entrance_sweep_id }) => {
      if (!run.twin) return json({ error: "Call fetch_twin first." });
      const g = sweepsToGraph(run.twin.sweeps, {
        floorId: floor_id,
        entranceSweepId: entrance_sweep_id ?? undefined,
        walls: run.twin.walls?.[floor_id] ?? [],
      });
      run.graph = g;
      run.graphFloorId = floor_id;
      logEvent(run, "build_draft_graph", { nodes: g.nodes.length, edges: g.edges.length, components: g.components.length });
      return json({
        nodes: g.nodes.length,
        edges: g.edges.length,
        edge_source: g.edgeSource,
        size_m: [Math.round(g.widthM), Math.round(g.heightM)],
        connected_parts: g.components.length,
        fully_connected: g.components.length === 1,
        warnings: g.warnings,
      });
    },
    {
      name: "build_draft_graph",
      description: "Convert one floor's scan points into a draft walkable graph (scan points → nodes, scanner moves → edges). Optionally mark the sweep at the entrance.",
      schema: z.object({ floor_id: z.string(), entrance_sweep_id: z.string().nullable() }),
    },
  );

  const proposeLandmarks = tool(
    async ({ max }) => {
      if (!run.graph || !run.twin) return json({ error: "Call build_draft_graph first." });
      const degree = new Map(run.graph.nodes.map((n) => [n.id, 0]));
      for (const e of run.graph.edges) {
        degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
        degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
      }
      // Decision points (intersections, dead ends, the entrance) are where a shopper most needs to re-localize.
      const picks = run.graph.nodes
        .filter((n) => n.kind === "entrance" || degree.get(n.id) !== 2)
        .sort((a, b) => Number(b.kind === "entrance") - Number(a.kind === "entrance") || (degree.get(b.id)! - degree.get(a.id)!))
        .slice(0, max)
        .map((n) => n.sweepId!)
        .filter(Boolean);
      run.landmarkSweepIds = picks;
      const withPano = new Set(run.twin.panoramas.map((p) => p.sweepId));
      logEvent(run, "propose_landmarks", { picks });
      return json({ landmark_sweep_ids: picks, with_panorama: picks.filter((p) => withPano.has(p)).length, panorama_urls: run.twin.panoramas.filter((p) => picks.includes(p.sweepId)) });
    },
    {
      name: "propose_landmarks",
      description: "Choose scan points at decision points (entrance, intersections, dead ends) whose panoramas become visual-localization references.",
      schema: z.object({ max: z.number().int().min(1).max(12) }),
    },
  );

  const recognizeShelfImage = tool(
    async ({ image_url, aisle }) => {
      const candidates = await recognizeShelf(image_url, aisle ? { aisle } : undefined);
      for (const c of candidates) run.candidates.push({ ...c, image_url, review_status: "NEEDS_REVIEW" });
      logEvent(run, "recognize_shelf_image", { image_url, candidates: candidates.length });
      return json({ candidates_queued_for_review: candidates.length, sample: candidates.slice(0, 5).map((c) => c.name) });
    },
    {
      name: "recognize_shelf_image",
      description: "Identify products visible in one shelf image or panorama crop. Results are queued as NEEDS_REVIEW suggestions for staff.",
      schema: z.object({ image_url: z.string(), aisle: z.string().nullable() }),
    },
  );

  const saveDraftTool = tool(
    async () => {
      if (!run.graph) return json({ error: "Nothing to save: build_draft_graph first." });
      const d = await saveDraft({
        store_id: run.storeId,
        agent_run_id: run.runId,
        source: run.layers.source,
        graph: run.graph,
        landmark_sweep_ids: run.landmarkSweepIds,
        candidates: run.candidates,
      });
      run.draftId = d.id;
      // Product suggestions go to the staff Review queue as NEEDS_REVIEW (no shelf). Only once per run, so a repeated
      // save_draft call doesn't queue duplicates. A failure here doesn't lose them: they are inside the draft.
      let review: { queued: number } | { error: string } = { queued: run.observationIds.length };
      if (!run.observationIds.length && run.candidates.length) {
        const from = run.property ? `${run.property.name} (${run.layers.source === "fixture" ? "fixture data" : "CoStar"})` : "the digital twin";
        try {
          const { ids } = await queueAiObservations(run.storeId, run.candidates, `Onboarding agent run ${run.runId}, shelf recognition on ${from}.`);
          run.observationIds = ids;
          review = { queued: ids.length };
        } catch (err) {
          review = { error: err instanceof Error ? err.message : String(err) };
        }
      }
      logEvent(run, "save_draft", { draft_id: d.id, review });
      return json({
        draft_id: d.id,
        status: "DRAFT — staff must review and publish in the map editor",
        product_suggestions: "error" in review
          ? `Could not add suggestions to the Review queue: ${review.error}. They are saved in the draft.`
          : `${review.queued} queued in Review as NEEDS_REVIEW; staff must choose a shelf for each before publishing.`,
      });
    },
    {
      name: "save_draft",
      description: "Save the draft map, landmark choices and product suggestions for staff review. This does not publish anything.",
      schema: z.object({}),
    },
  );

  return { main: [lookupProperty, fetchTwin, inspectAerial, buildDraftGraph, proposeLandmarks, saveDraftTool], shelf: [recognizeShelfImage] };
}
