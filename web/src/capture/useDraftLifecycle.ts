import { useEffect, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import type { CaptureContext } from "./captureContext";
import type { Draft, RecordedWarning } from "./draft";
import { clearDraft, loadDraft, saveHeader, startDraft } from "./draft";
import { stampSubject } from "../api/token";
import { mayCarry } from "./outbox";
import { halfEnteredCell } from "./payload";
import { draftRead, inspectionEnded, storageRefused, writeFailed } from "./storageFaults";

export type Screen = "start" | "capture" | "review" | "done";

// Owns the draft's own lifecycle (FR-OFF-005/006/013/014): the load-on-mount
// resume, the report of what storage did to the storage faults store
// (TYRE-339), and the two discards. attachedIds
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
  // The resumed draft's startedAt, for the context reads (U148). A Start does
  // not set it, since a fresh capture is read at now (FR-AUT-005).
  const [resumedStartedAt, setResumedStartedAt] = useState<string | null>(null);
  const [held, setHeld] = useState<Draft | null>(null);
  const [screen, setScreen] = useState<Screen>("start");
  // Bumped by the retry to re-run the draft load (FR-OFF-013): a recovery
  // action is only real if something re-attempts.
  const [storageAttempt, setStorageAttempt] = useState(0);
  // U104: no subject, no draft; and another driver's draft never resumes here.
  const [signInNeeded, setSignInNeeded] = useState(false);
  const [otherDriverHeld, setOtherDriverHeld] = useState(false);

  // FR-OFF-006 / NFR-USE-011: a remount is a reload, such as a killed browser,
  // a phone call, or a driver returning after lunch, and it has to find the work.
  useEffect(() => {
    let dropped = false;
    void loadDraft().then(
      (existing) => {
        if (dropped) return;
        draftRead(existing !== undefined);
        setResumedStartedAt(null);
        if (existing && !mayCarry(existing, stampSubject())) {
          // U104: held for its own driver, never resumed or offered for
          // discard under another (FR-OFF-014).
          setOtherDriverHeld(true);
        } else if (existing?.vehicleId === vehicleId) {
          setResumedStartedAt(existing.startedAt);
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
        storageRefused();
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
    const driverSubject = stampSubject();
    if (driverSubject === null) {
      // U104: a draft stamped for nobody could never be sent (mayCarry).
      setSignInNeeded(true);
      return;
    }
    setSignInNeeded(false);
    try {
      await startDraft({
        driverSubject,
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
      storageRefused();
    }
  }

  // Clears nothing itself: the read it re-runs decides whether the fault
  // stands (storageFaults.ts).
  function retryStorage() {
    setResumed(false);
    setStorageAttempt((n) => n + 1);
  }

  // TYRE-146: the only way out of a wrong-vehicle Start. Everything the
  // driver typed for that vehicle goes with it, which is why ConfirmDiscard
  // is told the number, and the device is then free to start this one.
  function discardHeld() {
    void clearDraft().then(
      () => {
        inspectionEnded();
        setHeld(null);
      },
      () => writeFailed(),
    );
  }

  function discardCurrent() {
    void clearDraft().then(
      () => {
        inspectionEnded();
        setDraft(null);
        setActiveKey(null);
        setAttachedIds(null);
        // A new capture is judged over its own window, so its Start screen
        // reads at now (FR-AUT-005).
        setResumedStartedAt(null);
        setScreen("start");
      },
      () => writeFailed(),
    );
  }

  return {
    draft,
    setDraft,
    resumed,
    resumedStartedAt,
    held,
    screen,
    setScreen,
    signInNeeded,
    otherDriverHeld,
    startDraftAndAdvance,
    retryStorage,
    discardHeld,
    discardCurrent,
  };
}
