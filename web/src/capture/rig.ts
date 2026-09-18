import type { CaptureContext, CapturePosition } from "./captureContext";
import { cellKey } from "./draft";

export interface RigPosition {
  position: CapturePosition;
  // Identity of this cell across the rig: two member units of one
  // configuration share every position id, so nothing may key on the id
  // alone (BR-VEH-003, draft.cellKey).
  key: string;
  // The unit that owns it, kept alongside so the sheet can show the fleet
  // number and read that unit's own configuration.
  context: CaptureContext;
  // FR-VEH-034: computed, rendered, discarded, never stored or transmitted
  // (BR-VEH-003 as amended by E2). Null for a spare, which is not in the
  // walk-around sequence.
  displayNumber: number | null;
}

export function rigPositions(contexts: CaptureContext[]): RigPosition[] {
  let running = 0;
  return contexts.flatMap((context) =>
    [...context.positions]
      // TYRE-155/rule 5: a tenant with spare capture off gets no spare cell
      // at all, filtered before the sort. Compared against !== false, not
      // truthiness, so an absent key (old cached response) fails toward
      // capturing, not toward silently dropping (ADR-0010).
      .filter((p) => (p.isSpare ? context.config.captureSpares !== false : true))
      // BR-VEH-001 numbers positions within a unit from position.sequence,
      // so sorting by it means the projection depends on the
      // configuration, not on API order.
      .sort((a, b) => a.sequence - b.sequence)
      .map((position) => ({
        position,
        key: cellKey(position.vehicleId, position.id),
        context,
        displayNumber: position.isSpare ? null : ++running,
      })),
  );
}

// The two rows the diagram draws, in that order: running positions then
// spares, split here because the flow's next-position jump must follow
// the picture the driver reads.
export function splitSpares(positions: RigPosition[]): {
  running: RigPosition[];
  spares: RigPosition[];
} {
  return {
    running: positions.filter((r) => r.displayNumber !== null),
    spares: positions.filter((r) => r.displayNumber === null),
  };
}

// The next position after this one, wrapping to the first outstanding,
// forward-first (a skipped wheel is returned to, not dragged backwards
// after every position). Asked by CELL (BR-VEH-003, draft.cellKey).
export function nextOutstanding(
  positions: RigPosition[],
  doneCells: ReadonlySet<string>,
  afterCell: string,
): RigPosition | null {
  const { running, spares } = splitSpares(positions);
  const order = [...running, ...spares];
  const outstanding = (r: RigPosition) => !doneCells.has(r.key);
  // -1 when the cell is not on this rig, which makes the forward search the
  // whole list. The same answer as the wrap, and the only sensible one.
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
  // TYRE-155: an absent spare is neither done nor outstanding. It leaves the
  // denominator, so a unit with no spare can read "all done" (FR-INS-066).
  absentCells: ReadonlySet<string>,
): UnitCompleteness[] {
  return contexts.map((context) => {
    const cells = context.positions
      // Same rule as rigPositions above: fail toward the Must (FR-INS-066)
      // on an absent key rather than toward dropping the spare (ADR-0010).
      .filter((p) => (p.isSpare ? context.config.captureSpares !== false : true))
      .map((p) => cellKey(p.vehicleId, p.id))
      .filter((c) => !absentCells.has(c));
    return {
      vehicleId: context.vehicleId,
      fleetNumber: context.fleetNumber,
      done: cells.filter((c) => doneCells.has(c)).length,
      total: cells.length,
    };
  });
}
