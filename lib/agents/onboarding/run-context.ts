import type { CostarProperty, DataLayers, TwinModel } from "../../costar";
import type { DraftGraph } from "../../twin/sweepsToGraph";
import type { ShelfCandidate } from "../../vision/recognizeShelf";

/** Mutable per-run state the onboarding tools read and write. One instance per agent run. */
export interface OnboardingRun {
  runId: string;
  /** Store the draft and product suggestions belong to. */
  storeId: string;
  layers: DataLayers;
  log: { at: string; event: string; detail?: unknown }[];
  property?: CostarProperty;
  twin?: TwinModel;
  graph?: DraftGraph;
  /** Floor the draft graph was built on (for drawing it over that floor's plan). */
  graphFloorId?: string;
  aerialNotes?: string;
  landmarkSweepIds: string[];
  candidates: (ShelfCandidate & { image_url: string; review_status: "NEEDS_REVIEW" })[];
  draftId?: string;
  /** Review-queue observation ids created from `candidates` by save_draft. */
  observationIds: string[];
}

export const DEFAULT_STORE_ID = "demo-store";

export function newRun(runId: string, layers: DataLayers, storeId: string = DEFAULT_STORE_ID): OnboardingRun {
  return { runId, storeId, layers, log: [], landmarkSweepIds: [], candidates: [], observationIds: [] };
}

export function logEvent(run: OnboardingRun, event: string, detail?: unknown) {
  run.log.push({ at: new Date().toISOString(), event, detail });
}
