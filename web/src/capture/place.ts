import type { RigPosition } from "./rig";

// Here, not domain/vocabulary, which the capture entry may not import.
const SIDE_WORD: Record<"LEFT" | "RIGHT", string> = { LEFT: "left", RIGHT: "right" };

// FR-INS-060, FR-VEH-034 (U156): a tile shows the rig-wide number, so the
// per-unit place goes in its name and the sheet's header, from wire fields
// only. A spare has no axle or side (captureContext.ts), so it has none.
export function placeWords(rig: RigPosition): string | null {
  const { axleNumber, side } = rig.position;
  if (rig.displayNumber === null || axleNumber === null || side === null) return null;
  return `axle ${axleNumber}, ${SIDE_WORD[side]}`;
}
