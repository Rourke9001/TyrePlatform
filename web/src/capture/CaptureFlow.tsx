import type { ReactNode } from "react";
import { useState } from "react";

import { CaptureDiagram } from "./CaptureDiagram";
import { CaptureDone } from "./CaptureDone";
import { CaptureReview } from "./CaptureReview";
import { CaptureStart } from "./CaptureStart";
import { ConfirmDiscard } from "./ConfirmDiscard";
import type { RecordedWarning } from "./draft";
import { saveHeader } from "./draft";
import { useCaptureContext } from "./captureContext";
import { attemptSend, listOutbox, queueDraft } from "./outbox";
import { absentCells, appVersion, capturedCells, deviceId } from "./payload";
import { PositionSheet } from "./PositionSheet";
import { deriveProgress } from "./rig";
import { useDraftLifecycle } from "./useDraftLifecycle";
import { useEntryHandlers } from "./useEntryHandlers";
import { useRigComposition } from "./useRigComposition";
import "./capture.css";

interface Outcome {
  state: "sent" | "queued" | "failed";
  lastCode: string | null;
}

export function CaptureFlow({ vehicleId, taskId }: { vehicleId: string; taskId: string | null }) {
  const motive = useCaptureContext(vehicleId);

  // A cell, not a position id: two member units of the same axle
  // configuration share every position id, so an id alone opens the wrong
  // unit's sheet on a rig (draft.cellKey). Owned here, not by any one
  // hook below, since the draft's resume and the entry handlers both
  // write it.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // FR-INS-062: which member units are confirmed attached. Owned here, not
  // by useRigComposition, since the draft's resume and discard also write
  // it.
  const [attachedIds, setAttachedIds] = useState<string[] | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Frozen at mount, same reason as CaptureStart: severityOf runs once per
  // cell per render, and a wear-rate comparison must not move with a
  // re-render.
  const [openedAt] = useState(() => Date.now());

  const lifecycle = useDraftLifecycle(vehicleId, taskId, setActiveKey, setAttachedIds);
  const { draft, setDraft, resumed, held, screen, setScreen, storageFault } = lifecycle;

  const rigComp = useRigComposition(motive.data, vehicleId, resumed, attachedIds, setAttachedIds);
  const { confirmedIds, contexts, membersFailed, toggleAttached } = rigComp;

  const progress = deriveProgress(contexts, draft, openedAt);
  const { doneCells, absent, units, doneCount, totalPositions, severityOf, governingOf } = progress;
  const motiveCtx = contexts?.find((c) => c.vehicleId === vehicleId) ?? contexts?.[0];
  const active = activeKey === null ? undefined : progress.byCell.get(activeKey);

  const { handleChange, handleDone, handleAbsent } = useEntryHandlers({
    setDraft,
    setActiveKey,
    setStorageFault: lifecycle.setStorageFault,
    rig: progress.rig,
    doneCells,
    absent,
  });

  function handleStart(init: {
    odometerKm: number | null;
    observedMemberVehicleIds: string[];
    warnings: RecordedWarning[];
  }) {
    const ctx = motive.data;
    if (!ctx) return;
    setAttachedIds(init.observedMemberVehicleIds);
    void lifecycle.startDraftAndAdvance(ctx, init);
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
        lifecycle.setStorageFault("degraded");
        setSubmitting(false);
      }
    })();
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
          onConfirm={lifecycle.discardHeld}
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
          positions={progress.rig}
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
          onConfirm={lifecycle.discardCurrent}
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
            <button type="button" className="cap-secondary" onClick={lifecycle.retryStorage}>
              Recheck storage
            </button>
          )}
        </div>
      )}
      {body}
    </>
  );
}
