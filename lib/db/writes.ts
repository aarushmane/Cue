// Writes used by the agents. Supabase when configured; otherwise an in-memory log (demo / local only —
// lost on restart, which is acceptable because published inventory still comes from the seed).
import type { DraftGraph } from "../twin/sweepsToGraph";
import type { ShelfCandidate } from "../vision/recognizeShelf";
import { getAdminDb } from "./admin";

export interface DraftMapRecord {
  id: string;
  store_id: string | null;
  agent_run_id: string;
  source: "costar" | "fixture";
  graph: DraftGraph;
  landmark_sweep_ids: string[];
  candidates: (ShelfCandidate & { image_url: string; review_status: "NEEDS_REVIEW" })[];
  created_at: string;
}

const memory = {
  reports: [] as { store_id: string; product_id: string | null; note: string; created_at: string }[],
  drafts: [] as DraftMapRecord[],
};

export function memoryLog() {
  return memory;
}

export async function saveShopperReports(storeId: string, reports: { product_id: string | null; note: string }[]) {
  if (reports.length === 0) return;
  const db = getAdminDb();
  if (!db) {
    for (const r of reports) memory.reports.push({ store_id: storeId, ...r, created_at: new Date().toISOString() });
    return;
  }
  const { error } = await db.from("shopper_reports").insert(reports.map((r) => ({ store_id: storeId, product_id: r.product_id, note: r.note })));
  if (error) throw new Error(error.message);
}

/**
 * Persist the onboarding agent's output as a DRAFT. Never publishes: staff review the map in the editor and the
 * candidates in the review queue. In Supabase mode the draft is stored on the agent run (output_json) until the
 * map editor turns it into a DRAFT store_maps version — that conversion is the editor's job (Builder A/B).
 */
export async function saveDraft(record: Omit<DraftMapRecord, "id" | "created_at">): Promise<DraftMapRecord> {
  const full: DraftMapRecord = { ...record, id: `draft-${Date.now().toString(36)}`, created_at: new Date().toISOString() };
  const db = getAdminDb();
  if (!db) {
    memory.drafts.push(full);
    return full;
  }
  const { error } = await db.from("agent_runs").update({ output_json: full }).eq("id", record.agent_run_id);
  if (error) throw new Error(error.message);
  return full;
}

export async function startAgentRun(input: Record<string, unknown>, storeId: string | null, userId: string | null): Promise<string> {
  const db = getAdminDb();
  if (!db) return `run-${Date.now().toString(36)}`;
  const { data, error } = await db.from("agent_runs").insert({ kind: "onboarding", store_id: storeId, input_json: input, started_by: userId }).select("id").single();
  if (error) throw new Error(error.message);
  return data.id as string;
}

export async function finishAgentRun(runId: string, status: "SUCCEEDED" | "FAILED", todos: unknown, log: unknown) {
  const db = getAdminDb();
  if (!db) return;
  await db.from("agent_runs").update({ status, todos_json: todos ?? [], log_json: log ?? [], finished_at: new Date().toISOString() }).eq("id", runId);
}
