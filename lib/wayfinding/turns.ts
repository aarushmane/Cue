// Positive angles turn right; negative angles turn left.
export type Turn = "straight" | "slight_left" | "slight_right" | "left" | "right" | "around";

export function classifyTurn(angleDeg: number): Turn {
  const a = Math.abs(angleDeg);
  if (a < 25) return "straight";
  if (a > 155) return "around";
  const side = angleDeg > 0 ? "right" : "left";
  return a < 60 ? (`slight_${side}` as Turn) : side;
}
