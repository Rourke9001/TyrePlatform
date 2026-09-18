import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";

import { CaptureDiagram } from "./CaptureDiagram";
import { CaptureDone } from "./CaptureDone";
import { CaptureReview } from "./CaptureReview";
import { CaptureStart } from "./CaptureStart";
import { ConfirmDiscard } from "./ConfirmDiscard";
import type { CaptureContext, CapturePosition } from "./captureContext";
import { captureContextQuery, useCaptureContext } from "./captureContext";
import type { Draft, DraftPosition, RecordedWarning } from "./draft";
import {
  cellKey,
  clearDraft,
  loadDraft,
  markSpareAbsent,
  saveHeader,
  savePosition,
  startDraft,
  unmarkSpareAbsent,
} from "./draft";
import { historyWarnings } from "./history";
import { attemptSend, listOutbox, queueDraft } from "./outbox";
import { absentCells, appVersion, capturedCells, deviceId, halfEnteredCell } from "./payload";
import { PositionSheet } from "./PositionSheet";
import { completenessByUnit, nextOutstanding, rigPositions } from "./rig";
import type { Severity } from "./warnings";
import { governingTread, positionWarnings, severityFor, treadsRead } from "./warnings";
import "./capture.css";

type Screen = "start" | "capture" | "review" | "done";

// "unavailable": a device that will not let the app write at all (private
// window, MDM), caught before any inspection exists. "degraded": a write
// failed with an inspection already in hand. NFR-USE-005: the two must stay
// distinct on the wire.
type StorageFault = "unavailable" | "degraded";

interface Outcome {
  state: "sent" | "queued" | "failed";
  lastCode: string | null;
}

export function CaptureFlow({ vehicleId, taskId }: { vehicleId: string; taskId: string | null }) {
  const motive = useCaptureContext(vehicleId);

  // React state mirrors the draft for rendering; the draft in IndexedDB is the
  // truth (FR-OFF-005/006). Every mutation writes there first and updates this
  // to match, never the other way round. A reload has to find the work.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [resumed, setResumed] = useState(false);
  const [held, setHeld] = useState<Draft | null>(null);
  const [screen, setScreen] = useState<Screen>("start");
  const [attachedIds, setAttachedIds] = useState<string[] | null>(null);
  // A cell, not a position id: two member units of the same axle
  // configuration share every position id, so an id alone opens the wrong
  // unit's sheet on a rig (draft.cellKey).
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [storageFault, setStorageFault] = useState<StorageFault | null>(null);
  // Bumped by the retry to re-run the draft load (FR-OFF-013): a recovery
  // action is only real if something re-attempts.
  const [storageAttempt, setStorageAttempt] = useState(0);
  // Frozen at mount, same reason as CaptureStart: severityOf runs once per
  // cell per render, and a wear-rate comparison must not move with a
  // re-render.
  const [openedAt] = useState(() => Date.now());

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
  }, [vehicleId, storageAttempt]);

  // FR-INS-062's default: seeded with EVERY member id, motive included (its
  // checkbox is disabled), or the driver's own truck renders as not-here.
  // Derived, not written back by an effect: it waits for the draft load,
  // which may narrow it.
  const seededIds = motive.data
    ? (motive.data.combination?.members.map((m) => m.vehicleId) ?? [motive.data.vehicleId])
    : null;
  const confirmedIds = attachedIds ?? (resumed ? seededIds : null);

  // One GET per confirmed unit, all of them at start while the driver still
  // has signal (FR-OFF-001). Each unit keeps its own configuration and its own
  // thresholds; only the walk-around numbering is projected across the rig.
  const memberIds = memberOrder(motive.data, confirmedIds, vehicleId);
  const memberQueries = useQueries({ queries: memberIds.map(captureContextQuery) });
  const loaded = memberQueries
    .map((q) => q.data)
    .filter((c): c is CaptureContext => c !== undefined);
  const contexts = loaded.length === memberIds.length && memberIds.length > 0 ? loaded : null;
  const membersFailed = memberQueries.some((q) => q.isError);

  const rig = contexts ? rigPositions(contexts) : [];
  const byCell = new Map(rig.map((r) => [r.key, r]));
  const doneCells = draft ? capturedCells(draft) : new Set<string>();
  // TYRE-155: an absent spare is settled without being a reading. Off the
  // denominator (rig.ts) and off the outstanding walk (nextOutstanding calls
  // below), the same way a captured cell is off both.
  const absent = draft ? absentCells(draft) : new Set<string>();
  const units = contexts ? completenessByUnit(contexts, doneCells, absent) : [];
  const doneCount = units.reduce((n, u) => n + u.done, 0);
  // The one denominator, both the on-screen total and completeness_pct's
  // divisor. The two numerators (doneCount, payload's) are computed apart
  // but agree only because both answer to warnings.treadsRead.
  const totalPositions = units.reduce((n, u) => n + u.total, 0);
  const motiveCtx = contexts?.find((c) => c.vehicleId === vehicleId) ?? contexts?.[0];
  const active = activeKey === null ? undefined : byCell.get(activeKey);

  // Recomputed from the readings, not read off draft.positions[].warnings,
  // since those are written only when a position finishes. Banded on
  // treadsRead: requiring pressure too would hide FR-INS-036 on a
  // tread-complete cell.
  function severityOf(cell: string): Severity {
    const saved = draft?.positions[cell];
    const r = byCell.get(cell);
    if (!saved || !r) return "unmeasured";
    const entry = { treads: saved.treads, pressureKpa: saved.pressureKpa };
    return severityFor(
      [
        ...positionWarnings(entry, r.position, r.context.config),
        ...historyWarnings(entry, r.position, r.context, new Date(openedAt)),
      ],
      treadsRead(saved.treads),
    );
  }

  function governingOf(cell: string): number | null {
    return governingTread(draft?.positions[cell]?.treads ?? []);
  }

  function handleStart(init: {
    odometerKm: number | null;
    observedMemberVehicleIds: string[];
    warnings: RecordedWarning[];
  }) {
    const ctx = motive.data;
    if (!ctx) return;
    setAttachedIds(init.observedMemberVehicleIds);
    void (async () => {
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
    })();
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

  // TYRE-146: markSpareAbsent is an observation, not a reading, and
  // clearDraft discards it too. A draft holding only that mark is not
  // empty.
  const lostWords = (n: number, a: number) => {
    if (n === 0 && a === 0) return "No positions captured yet.";
    const captured = n > 0 ? `${n} captured position${n === 1 ? "" : "s"}` : "";
    const spares = a > 0 ? `${a} "No spare" mark${a === 1 ? "" : "s"}` : "";
    const parts = [captured, spares].filter(Boolean);
    return `${parts.join(" and ")} will be lost.`;
  };

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

  function handleSubmit(patch: { comment: string | null; defectReport: string | null }) {
    if (submitting || !draft || !motiveCtx) return;
    setSubmitting(true);
    void (async () => {
      try {
        await saveHeader(patch);
        const entry = await queueDraft({
          submittedAt: new Date().toISOString(),
          // The configured granularity, stamped on every reading (FR-INS-021).
          // The payload carries one value for the whole inspection (payload.ts).
          granularityMm: motiveCtx.config.treadGranularityMm,
          deviceId: deviceId(),
          appVersion,
          totalPositions,
        });
        await attemptSend(entry.clientUuid);
        // The queue, not the response, decides what the driver is told: a
        // dead network and a refusal reach here the same way and mean
        // opposite things (FR-OFF-012 vs FR-OFF-013).
        const still = (await listOutbox()).find((e) => e.clientUuid === entry.clientUuid);
        setOutcome(
          still === undefined
            ? { state: "sent", lastCode: null }
            : {
                state: still.state === "failed" ? "failed" : "queued",
                lastCode: still.lastCode ?? null,
              },
        );
        setDraft(null);
        setScreen("done");
      } catch {
        // An inspection is in hand and still on screen, so this is recoverable
        // in a way the pre-start case is not.
        setStorageFault("degraded");
        setSubmitting(false);
      }
    })();
  }

  function toggleAttached(id: string) {
    setAttachedIds((ids) => {
      const current = ids ?? seededIds ?? [vehicleId];
      return current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    });
  }

  let body: ReactNode;
  if (screen === "done" && outcome) {
    body = <CaptureDone state={outcome.state} lastCode={outcome.lastCode} />;
  } else if (!resumed || motive.isPending) {
    body = <p className="cap-wait">Loading…</p>;
  } else if (held) {
    const heldName = held.fleetNumber ?? "the other vehicle";
    body = (
      <section className="cap-screen">
        <p role="alert" className="cap-alert cap-alert--stop">
          An inspection for another vehicle is still open on this phone. Finish that one first.
        </p>
        <a className="cap-primary" href={`/capture/${held.vehicleId}`}>
          Go to it
        </a>
        <ConfirmDiscard
          trigger="Discard it"
          question={`Discard the inspection of ${heldName}?`}
          consequence={lostWords(capturedCells(held).size, absentCells(held).size)}
          confirm="Discard"
          onConfirm={discardHeld}
        />
      </section>
    );
  } else if (motive.isError || !motive.data) {
    // NFR-AVL-002: starting requires the server; every threshold and
    // warning depends on data that must have arrived. The storage-unavailable
    // alert is hoisted so its retry can sit beside this screen's own, each
    // naming its own action.
    body = (
      <section className="cap-screen">
        <p role="alert" className="cap-alert cap-alert--stop">
          Could not load this vehicle. Find signal and try again.
        </p>
        <button type="button" className="cap-primary" onClick={() => void motive.refetch()}>
          Reload vehicle
        </button>
      </section>
    );
  } else if (screen === "start") {
    body = (
      <CaptureStart
        motive={motive.data}
        storageBlocked={storageFault === "unavailable"}
        attachedIds={confirmedIds ?? [vehicleId]}
        onToggleAttached={toggleAttached}
        onStart={handleStart}
      />
    );
  } else if (membersFailed) {
    body = (
      <section className="cap-screen">
        <p role="alert" className="cap-alert cap-alert--stop">
          Could not load the rest of the rig. Find signal and try again. Your readings are saved.
        </p>
      </section>
    );
  } else if (!contexts || !draft) {
    body = <p className="cap-wait">Loading…</p>;
  } else if (screen === "review") {
    body = (
      <CaptureReview
        contexts={contexts}
        draft={draft}
        doneCells={doneCells}
        absentCells={absent}
        onBack={() => setScreen("capture")}
        onSubmit={handleSubmit}
      />
    );
  } else {
    body = (
      <section className="cap-screen cap-capture" aria-labelledby="capture-heading">
        <header className="cap-screen-head">
          <p className="cap-eyebrow">{motiveCtx?.fleetNumber}</p>
          {/* FR-INS-065: progress belongs above the diagram, not only at review.
            A driver mid-walk-around needs to know which unit is short while
            they are still standing next to it. */}
          <h1 id="capture-heading" className="cap-screen-title">
            {doneCount} of {totalPositions} done
          </h1>
          {units.length > 1 && (
            <ul className="cap-tally">
              {units.map((u) => (
                <li key={u.vehicleId} className="cap-tally-row">
                  <span className="cap-tally-id">{u.fleetNumber}</span>
                  <span className="cap-tally-count">
                    {u.done}/{u.total}
                  </span>
                  <span className="cap-tally-note">
                    {u.done === u.total ? "all done" : `${u.total - u.done} left`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </header>

        <CaptureDiagram
          positions={rig}
          severityOf={severityOf}
          governingOf={governingOf}
          onOpen={setActiveKey}
          activeKey={activeKey}
          absentCells={absent}
        />

        <button type="button" className="cap-primary" onClick={() => setScreen("review")}>
          Review and submit ›
        </button>

        {/* Below the primary action and secondary in weight: a recovery path,
            never on the clean one (0 taps; 2 to discard). */}
        <ConfirmDiscard
          trigger="Discard this inspection"
          question={`Discard the inspection of ${motiveCtx?.fleetNumber ?? draft.fleetNumber ?? "this vehicle"}?`}
          consequence={lostWords(doneCount, absent.size)}
          confirm="Discard"
          onConfirm={discardCurrent}
        />

        {/* Laid over the diagram rather than replacing it: the active cell is
          the driver's place-keeper across 27 positions, and remounting the
          picture on every position is both slower and a new screen to
          re-read. Keyed on the position so reopening one gets a fresh sheet
          seeded from the draft rather than the previous position's state. */}
        {active && (
          <div className="cap-sheet-layer">
            <PositionSheet
              key={active.key}
              rig={active}
              ctx={active.context}
              initial={draft.positions[active.key]}
              onChange={handleChange}
              onDone={handleDone}
              onClose={() => setActiveKey(null)}
              absent={absent.has(active.key)}
              onAbsent={handleAbsent}
            />
          </div>
        )}
      </section>
    );
  }

  // Above every branch, not inside one: the driver can be on any screen when
  // a fault fires. "degraded" stays non-blocking, since the readings are
  // still on screen and submittable.
  return (
    <>
      {storageFault !== null && (
        <div role="alert" className="cap-alert cap-alert--stop cap-storage">
          <p className="cap-storage-msg">
            {storageFault === "unavailable"
              ? "This phone is not letting the app save anything, so an inspection cannot be started. Private browsing or a work-phone setting usually causes this."
              : "This phone is not saving reliably. Keep the app open until this inspection has been sent."}
          </p>
          {storageFault === "unavailable" && (
            // Named for what it retries. See the motive.isError branch above
            // for why both retries need distinct labels.
            <button type="button" className="cap-secondary" onClick={retryStorage}>
              Recheck storage
            </button>
          )}
        </div>
      )}
      {body}
    </>
  );
}

// Walk order, which is the combination's own sequence. The projection has to
// follow the physical rig, not the order a checkbox happened to be ticked in
// (FR-VEH-034). A unit with no combination is its own single member.
function memberOrder(
  motive: CaptureContext | undefined,
  attachedIds: string[] | null,
  vehicleId: string,
): string[] {
  if (attachedIds === null) return [];
  const members = motive?.combination?.members;
  if (!members) return [vehicleId];
  const ordered = [...members]
    .sort((a, b) => a.sequence - b.sequence)
    .map((m) => m.vehicleId)
    .filter((id) => attachedIds.includes(id));
  return ordered.length > 0 ? ordered : [vehicleId];
}
