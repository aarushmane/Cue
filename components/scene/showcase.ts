// Showcase SDK bridge (browser only). Active only when NEXT_PUBLIC_MATTERPORT_SDK_KEY is set and the site's domain is
// allowed for that key; without it the tour still works and routes show on the 2D map instead of in the 3D view.
import type { MpSdk } from "@matterport/sdk";
import type { Projector } from "@/lib/wayfinding/screen";
import type { Vec3 } from "@/lib/wayfinding/types";

export const SDK_KEY = process.env.NEXT_PUBLIC_MATTERPORT_SDK_KEY ?? "";

export type Pose = MpSdk.Camera.Pose;

/** Attach the SDK to an existing Showcase iframe (its URL must already carry `applicationKey`). */
export async function connectShowcase(iframe: HTMLIFrameElement): Promise<MpSdk> {
  const { setupSdk } = await import("@matterport/sdk");
  return setupSdk(SDK_KEY, { iframe });
}

// Model API frame (z up, what the planner uses) ↔ Showcase SDK frame, using Matterport's own conversion.
const TO_SDK = "coordinatesToSDK" as MpSdk.Conversion.TransformType.Coordinates;
const TO_API = "coordinatesToAPI" as MpSdk.Conversion.TransformType.Coordinates;
export const toSdk = (sdk: MpSdk, p: Vec3): Vec3 => sdk.Conversion.basisChange(p, TO_SDK);
export const toApi = (sdk: MpSdk, p: Vec3): Vec3 => sdk.Conversion.basisChange(p, TO_API);

type V = { x: number; y: number; z: number };
const dot = (a: V, b: V) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Which way the camera looks, in the SDK frame. Pose.rotation is pitch (x) and yaw (y) in degrees; the yaw sign is not
 * documented, so both conventions are tried and the one that `worldToScreen` puts in the centre of the view wins.
 */
function cameraForward(sdk: MpSdk, pose: Pose, size: { w: number; h: number }): V {
  const pitch = (pose.rotation.x * Math.PI) / 180, yaw = (pose.rotation.y * Math.PI) / 180;
  const candidates: V[] = [
    { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) },
    { x: Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) },
  ];
  let best = candidates[0], bestErr = Infinity;
  for (const f of candidates) {
    const p = pose.position;
    const s = sdk.Conversion.worldToScreen({ x: p.x + f.x * 3, y: p.y + f.y * 3, z: p.z + f.z * 3 }, pose, size);
    const err = Math.hypot(s.x - size.w / 2, s.y - size.h / 2);
    if (Number.isFinite(err) && err < bestErr) { best = f; bestErr = err; }
  }
  return best;
}

/**
 * Model-frame point → Showcase screen pixels for the given camera pose and player size. Pixels come from the SDK's own
 * `worldToScreen`; whether the point is in front of the camera is decided from the camera's forward direction (depth
 * > 5 cm), so lines and arrows behind the visitor are never mirrored onto the screen.
 */
export function projectorFor(sdk: MpSdk, pose: Pose, size: { w: number; h: number }): Projector {
  const forward = cameraForward(sdk, pose, size);
  const eye = pose.position;
  return (p) => {
    const q = toSdk(sdk, p);
    const depth = dot({ x: q.x - eye.x, y: q.y - eye.y, z: q.z - eye.z }, forward);
    if (depth < 0.05) {
      // Behind: report a point mirrored through the centre (the convention edgeIndicator expects), on the side the
      // visitor should turn toward. right = forward × up.
      const side = (q.x - eye.x) * -forward.z + (q.z - eye.z) * forward.x;
      return { x: size.w / 2 - Math.sign(side || 1) * size.w, y: size.h / 2, z: 2 };
    }
    const s = sdk.Conversion.worldToScreen(q, pose, size);
    return { x: s.x, y: s.y, z: 0 };
  };
}

/** Walk the route one scan point at a time, then turn to face the next point (or the item). */
export async function stepAlong(sdk: MpSdk, waypointIds: string[], currentSweep: string, lookTarget: (nextIndex: number) => Vec3) {
  const at = waypointIds.indexOf(currentSweep);
  const next = Math.min(at + 1, waypointIds.length - 1);
  if (next < 0 || (at === next && at !== -1)) {
    await sdk.Camera.lookAt(toSdk(sdk, lookTarget(waypointIds.length - 1)));
    return;
  }
  await sdk.Sweep.moveTo(waypointIds[next], { transition: "transition.fly" as MpSdk.Sweep.Transition, transitionTime: 1200 });
  await sdk.Camera.lookAt(toSdk(sdk, lookTarget(next)));
}

export type ClientWaypoint = { id: string; position: Vec3; floor_id: string | null; neighbors: string[] };

/** Keep an up-to-date list of every enabled sweep, converted to the Model API frame. */
export function watchSweeps(sdk: MpSdk, onChange: (sweeps: ClientWaypoint[]) => void) {
  return sdk.Sweep.data.subscribe({
    onCollectionUpdated(collection) {
      onChange(Object.values(collection).filter((s) => s.enabled).map((s) => ({
        id: s.id,
        position: toApi(sdk, s.puckPosition ?? s.position),
        floor_id: s.floorInfo.id ?? null,
        neighbors: s.neighbors,
      })));
    },
  });
}
