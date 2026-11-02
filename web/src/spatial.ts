// Where a sound seems to come from. The listener is your craft, or the middle of the arena for a spectator, and the
// pan follows the camera's left and right so a shot on the left of the screen sounds on the left.

/** A point on the arena floor in centimetres, the unit of the ticks. */
export interface Point {
  x: number;
  z: number;
}

export interface Listener extends Point {
  /** The camera's yaw about the vertical axis. */
  yaw: number;
}

export interface Placed {
  /** -1 for all left to 1 for all right. */
  pan: number;
  /** 1 at the listener, falling to {@link FAR_GAIN} at `reach`. */
  gain: number;
}

/** The quietest a sound gets with distance, so a fight across the arena is still heard. */
export const FAR_GAIN = 0.4;
/** The pan at the screen's edge: never fully to one ear. */
const MAX_PAN = 0.85;

/** Pan and gain for a sound at `at`, which is null for one with no place (your own craft, the UI). `reach` is in centimetres. */
export function place(listener: Listener, at: Point | null, reach: number): Placed {
  if (at === null) return { pan: 0, gain: 1 };
  const dx = at.x - listener.x;
  const dz = at.z - listener.z;
  // The camera sits at (sin yaw, cos yaw) looking at the centre, so its right is (cos yaw, -sin yaw).
  const across = dx * Math.cos(listener.yaw) - dz * Math.sin(listener.yaw);
  const far = Math.min(1, Math.hypot(dx, dz) / reach);
  return {
    pan: Math.max(-MAX_PAN, Math.min(MAX_PAN, (across / reach) * 2 * MAX_PAN)),
    gain: 1 - (1 - FAR_GAIN) * far,
  };
}
