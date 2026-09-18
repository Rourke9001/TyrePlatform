import type { Dispatch, SetStateAction } from "react";

import type { Draft, DraftPosition } from "./draft";
import { cellKey, loadDraft, markSpareAbsent, savePosition, unmarkSpareAbsent } from "./draft";
import type { CapturePosition } from "./captureContext";
import type { RigPosition } from "./rig";
import { nextOutstanding } from "./rig";
import type { StorageFault } from "./useDraftLifecycle";

// Owns entering a reading and marking a spare absent: the three ways the
// draft's positions change once capture has started (FR-OFF-005,
// TYRE-155/FR-INS-066).
export function useEntryHandlers(deps: {
  setDraft: Dispatch<SetStateAction<Draft | null>>;
  setActiveKey: Dispatch<SetStateAction<string | null>>;
  setStorageFault: Dispatch<SetStateAction<StorageFault | null>>;
  rig: RigPosition[];
  doneCells: ReadonlySet<string>;
  absent: ReadonlySet<string>;
}) {
  const { setDraft, setActiveKey, setStorageFault, rig, doneCells, absent } = deps;

  // FR-OFF-005: written per keystroke, plus once more for auto-advance,
  // with an identical payload, so nothing may depend on the write count.
  function handleChange(position: DraftPosition) {
    setDraft((d) =>
      d
        ? {
            ...d,
            positions: {
              ...d.positions,
              [cellKey(position.vehicleId, position.positionId)]: position,
            },
          }
        : d,
    );
    void savePosition(position).catch(() => setStorageFault("degraded"));
  }

  function handleDone(position: DraftPosition) {
    handleChange(position);
    // Finishing a position opens the next outstanding one directly (against
    // NFR-USE-001a's budget). doneCells still lacks the just-finished cell
    // this render (setDraft has not committed), so it's added here to stop
    // the flow reopening a closed sheet.
    const finished = cellKey(position.vehicleId, position.positionId);
    const outstanding = new Set([...doneCells, ...absent]).add(finished);
    setActiveKey(nextOutstanding(rig, outstanding, finished)?.key ?? null);
  }

  // TYRE-155 / FR-INS-066: the one action on a spare sheet, recorded as an
  // observation rather than left as a gap the review screen cannot explain.
  // Marking one advances the same way finishing a reading does: the cell is
  // settled, so the walk moves on to whatever is still outstanding; taking a
  // mark back does not, since the driver is staying on this sheet to enter it.
  function handleAbsent(position: CapturePosition, isAbsent: boolean) {
    const cell = cellKey(position.vehicleId, position.id);
    void (
      isAbsent
        ? markSpareAbsent(position.vehicleId, position.id)
        : unmarkSpareAbsent(position.vehicleId, position.id)
    )
      .then(async () => {
        setDraft((await loadDraft()) ?? null);
        if (isAbsent) {
          const settled = new Set([...doneCells, ...absent]).add(cell);
          setActiveKey(nextOutstanding(rig, settled, cell)?.key ?? null);
        }
      })
      .catch(() => setStorageFault("degraded"));
  }

  return { handleChange, handleDone, handleAbsent };
}
