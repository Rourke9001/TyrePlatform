import type { CaptureContext, CapturePosition } from "./captureContext";
import { cellKey } from "./draft";

export interface RigPosition {
  position: CapturePosition;
  // Identity of this cell across the whole rig. Two member units of the same
  // axle configuration share every position id, so nothing that has to tell
  // one unit's wheel from another's may key on the id alone (draft.cellKey).
  key: string;
  // The unit that owns it, kept alongside so the sheet can show the fleet
  // number and read that unit's own configuration.
  context: CaptureContext;
  // FR-VEH-034: computed here, rendered, and discarded. It is never stored and
  // never transmitted (BR-VEH-003 as amended by E2) — the payload names
  // vehicle_id and position_id. Null for a spare, which is not in the
  // walk-around sequence at all.
  displayNumber: number | null;
}

export function rigPositions(contexts: CaptureContext[]): RigPosition[] {
  let running = 0;
  return contexts.flatMap((context) =>
    [...context.positions]
      // BR-VEH-001 numbers positions within a unit from 1, foremost axle
      // first, then left to right — which is exactly what position.sequence
      // already encodes. Sorting by it here means the projection depends on
      // the configuration, not on the order the API happened to return.
      .sort((a, b) => a.sequence - b.sequence)
      .map((position) => ({
        position,
        key: cellKey(position.vehicleId, position.id),
        context,
        displayNumber: position.isSpare ? null : ++running,
      })),
  );
}

export interface UnitCompleteness {
  vehicleId: string;
  fleetNumber: string;
  done: number;
  total: number;
}

// FR-INS-065: completeness per member unit as well as for the rig. The rig
// total is the sum, so it is not computed separately and cannot disagree.
export function completenessByUnit(
  contexts: CaptureContext[],
  doneCells: ReadonlySet<string>,
): UnitCompleteness[] {
  return contexts.map((context) => ({
    vehicleId: context.vehicleId,
    fleetNumber: context.fleetNumber,
    done: context.positions.filter((p) => doneCells.has(cellKey(p.vehicleId, p.id))).length,
    total: context.positions.length,
  }));
}
