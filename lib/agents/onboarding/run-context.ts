import type { CostarProperty, DataLayers, TwinModel } from "../../costar";
import type { DraftGraph } from "../../twin/sweepsToGraph";
import type { ShelfCandidate } from "../../vision/recognizeShelf";

/** Mutable per-run state the onboarding tools read and write. One instance per agent run. */
export interface OnboardingRun {
  runId: string;
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
}

export function newRun(runId: string, layers: DataLayers): OnboardingRun {
  return { runId, layers, log: [], landmarkSweepIds: [], candidates: [] };
}

export function logEvent(run: OnboardingRun, event: string, detail?: unknown) {
  run.log.push({ at: new Date().toISOString(), event, detail });
}
