import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { CaptureContext } from "./captureContext";
import type { Draft, RecordedWarning } from "./draft";
import { clearDraft, loadDraft, saveHeader, startDraft } from "./draft";
import { halfEnteredCell } from "./payload";

export type Screen = "start" | "capture" | "review" | "done";

// "unavailable": a device that will not let the app write at all (private
// window, MDM), caught before any inspection exists. "degraded": a write
// failed with an inspection already in hand. NFR-USE-005: the two must stay
// distinct on the wire.
export type StorageFault = "unavailable" | "degraded";

// Owns the draft's own lifecycle (FR-OFF-005/006/013/014): the load-on-mount
// resume, the storage fault a write can hit, and the two discards. attachedIds
// and activeKey are state the caller owns (CaptureFlow), since the rig
// composition and entry-handler concerns also write them; this hook is
// handed their setters rather than holding its own copies.
export function useDraftLifecycle(
  vehicleId: string,
  taskId: string | null,
  setActiveKey: Dispatch<SetStateAction<string | null>>,
  setAttachedIds: Dispatch<SetStateAction<string[] | null>>,
) {
  // React state mirrors the draft for rendering; the draft in IndexedDB is the
  // truth (FR-OFF-005/006). Every mutation writes there first and updates this
  // to match, never the other way round. A reload has to find the work.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [resumed, setResumed] = useState(false);
  const [held, setHeld] = useState<Draft | null>(null);
  const [screen, setScreen] = useState<Screen>("start");
  const [storageFault, setStorageFault] = useState<StorageFault | null>(null);
  // Bumped by the retry to re-run the draft load (FR-OFF-013): a recovery
  // action is only real if something re-attempts.
  const [storageAttempt, setStorageAttempt] = useState(0);

  // FR-OFF-006 / NFR-USE-011: a remount is a reload, such as a killed browser,
  // a phone call, or a driver returning after lunch, and it has to find the work.
  useEffect(() => {
    let dropped = false;
    void loadDraft().then(
      (existing) => {
        if (dropped) return;
        if (existing?.vehicleId === vehicleId) {
          setDraft(existing);
          setAttachedIds(
            existing.observedMemberVehicleIds.length > 0
              ? existing.observedMemberVehicleIds
              : [vehicleId],
          );
          setScreen("capture");
          // TYRE-148: back into the sheet the driver was typing in, if any.
          setActiveKey(halfEnteredCell(existing));
        } else if (existing) {
          // FR-OFF-014: one draft per device, and it is never silently
          // discarded. Only a person can decide the other one is finished.
          setHeld(existing);
        }
        setResumed(true);
      },
      () => {
        if (dropped) return;
        setStorageFault("unavailable");
        setResumed(true);
      },
    );
    return () => {
      dropped = true;
    };
  }, [vehicleId, storageAttempt, setActiveKey, setAttachedIds]);

  async function startDraftAndAdvance(
    ctx: CaptureContext,
    init: {
      odometerKm: number | null;
      observedMemberVehicleIds: string[];
      warnings: RecordedWarning[];
    },
  ) {
    try {
      await startDraft({
        vehicleId,
        taskId,
        // Rule 6: stored UTC. The tenant's timezone is applied on the way
        // out, not on the way in.
        startedAt: new Date().toISOString(),
        fleetNumber: ctx.fleetNumber,
        combinationId: ctx.combination?.id ?? null,
        observedMemberVehicleIds: init.observedMemberVehicleIds,
      });
      await saveHeader({ odometerKm: init.odometerKm, warnings: init.warnings });
      setDraft((await loadDraft()) ?? null);
      setScreen("capture");
    } catch {
      // No draft was written, so there is nothing to keep open and nothing
      // to send: this is the same standing refusal as a device that would
      // not let the app read one.
      setStorageFault("unavailable");
    }
  }

  function retryStorage() {
    setStorageFault(null);
    setResumed(false);
    setStorageAttempt((n) => n + 1);
  }

  // TYRE-146: the only way out of a wrong-vehicle Start. Everything the
  // driver typed for that vehicle goes with it, which is why ConfirmDiscard
  // is told the number, and the device is then free to start this one.
  function discardHeld() {
    void clearDraft().then(
      () => setHeld(null),
      () => setStorageFault("degraded"),
    );
  }

  function discardCurrent() {
    void clearDraft().then(
      () => {
        setDraft(null);
        setActiveKey(null);
        setAttachedIds(null);
        setScreen("start");
      },
      () => setStorageFault("degraded"),
    );
  }

  return {
    draft,
    setDraft,
    resumed,
    held,
    screen,
    setScreen,
    storageFault,
    setStorageFault,
    startDraftAndAdvance,
    retryStorage,
    discardHeld,
    discardCurrent,
  };
}
