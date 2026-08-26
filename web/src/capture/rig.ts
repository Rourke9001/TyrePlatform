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

// The two rows the diagram draws, in the order it draws them (CaptureDiagram):
// the running positions in walk-around sequence, then the spares. Split here
// rather than in each consumer because the flow's next-position jump has to
// follow the picture the driver is reading — a spare threaded back in at its
// own sequence would send them to the boot between two wheels.
export function splitSpares(positions: RigPosition[]): {
  running: RigPosition[];
  spares: RigPosition[];
} {
  return {
    running: positions.filter((r) => r.displayNumber !== null),
    spares: positions.filter((r) => r.displayNumber === null),
  };
}

// The next position a driver should be put in front of once one is finished:
// the outstanding position AFTER this one, wrapping round to the first
// outstanding one, and null when none are left. Forward first and then wrap,
// in that order — a driver who skipped a seized wheel early should finish the
// walk and be brought back to it, not dragged backwards after every position.
//
// Outstanding is asked by CELL. Two member units of the same axle configuration
// share every position id (draft.cellKey), so a search keyed on the bare id
// would read one trailer's wheel as the other's and walk the driver straight
// past a whole unit.
export function nextOutstanding(
  positions: RigPosition[],
  doneCells: ReadonlySet<string>,
  afterCell: string,
): RigPosition | null {
  const { running, spares } = splitSpares(positions);
  const order = [...running, ...spares];
  const outstanding = (r: RigPosition) => !doneCells.has(r.key);
  // -1 when the cell is not on this rig, which makes the forward search the
  // whole list — the same answer as the wrap, and the only sensible one.
  const from = order.findIndex((r) => r.key === afterCell);
  return order.slice(from + 1).find(outstanding) ?? order.find(outstanding) ?? null;
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
