// Distances for people: approximate walking steps instead of metres. Pure; shared by the planner's directions and the UI.

/** Average adult walking step (stride length), metres. */
export const STEP_M = 0.75;

/** Whole steps for a distance (at least 1). */
export const stepsFor = (metres: number) => Math.max(1, Math.round(metres / STEP_M));

/** "a step" / "about 6 steps". */
export function aboutSteps(metres: number): string {
  const n = stepsFor(metres);
  return n === 1 ? "a step" : `about ${n} steps`;
}
