import type { RoutePlan, SceneItem, Vec3 } from "@/lib/wayfinding/types";

export type VoiceAction = { type: "move" | "stop" } | { type: "turn"; degrees: number }
  | { type: "face"; target: "route" | "destination" } | { type: "speed"; metersPerSecond: number };
export type ViewPose = { position: Vec3; headingDeg: number; speedMps: number; walkingSpeedMps?: number; moving: boolean };
export const wrapHeading = (degrees: number) => ((degrees + 180) % 360 + 360) % 360 - 180;
export type VoiceMessage = { role: "user" | "assistant"; content: string };
export type VoiceResult = { reply: string; actions: VoiceAction[]; item: SceneItem | null; plan: RoutePlan | null; resetDestination?: boolean };
export type VoiceEvent =
  | { type: "progress"; stage: "loading" | "finding" | "locating" | "routing"; label: string }
  | { type: "route"; item: SceneItem | null; plan: RoutePlan }
  | { type: "action"; action: Exclude<VoiceAction, { type: "move" | "stop" }> | { type: "stop" } };
export type ViewControls = {
  stop: () => void; turn: (degrees: number) => void; moving: () => boolean; heading: () => number;
  pose?: () => ViewPose | null; face?: (position: Vec3) => void; speed?: (mps: number) => void;
  guide?: (plan: Extract<RoutePlan, { status: "OK" | "ALREADY_THERE" }>) => void;
};

/** New input invalidates both pending network work and any delayed scene/audio effects. */
export class VoiceTurn {
  private controller = new AbortController();
  begin() { this.cancel(); return this.controller.signal; }
  cancel() { this.controller.abort(); this.controller = new AbortController(); }
}

// These commands bypass the model. Avoid matching e.g. "find the bus stop".
export function isStopCommand(text: string) {
  return /^(?:(?:please|okay|ok|hey)[, ]+)?(?:stop|pause|wait|hold on|be quiet|quiet|cancel)(?:\s+(?:please|now|moving|walking|talking|speaking|the audio|everything))?[.!?,\s]*$/i.test(text.trim());
}
