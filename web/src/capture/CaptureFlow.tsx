import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useQueries } from "@tanstack/react-query";

import { CaptureDiagram } from "./CaptureDiagram";
import { CaptureDone } from "./CaptureDone";
import { CaptureReview } from "./CaptureReview";
import { CaptureStart } from "./CaptureStart";
import type { CaptureContext } from "./captureContext";
import { captureContextQuery, useCaptureContext } from "./captureContext";
import type { Draft, DraftPosition, RecordedWarning } from "./draft";
import { loadDraft, saveHeader, savePosition, startDraft } from "./draft";
import { historyWarnings } from "./history";
import { attemptSend, listOutbox, queueDraft } from "./outbox";
import { appVersion, capturedPositionIds, deviceId } from "./payload";
import { PositionSheet } from "./PositionSheet";
import { completenessByUnit, rigPositions } from "./rig";
import type { Severity } from "./warnings";
import { governingTread, positionWarnings, severityFor, treadsRead } from "./warnings";
import "./capture.css";

type Screen = "start" | "capture" | "review" | "done";

// Two different failures wearing one word. "unavailable" is a device that will
// not let the app write at all — a private window, an MDM policy — caught
// before there is any inspection: nothing can be captured, and it does not
// clear by waiting, because a browser mode is not a transient condition.
// "degraded" is a write that failed with an inspection already in hand: the
// readings are on screen and the submit path may still work.
//
// One string for both told a driver with no draft to keep an inspection open
// that does not exist, which under NFR-USE-005 is worse than saying nothing.
type StorageFault = "unavailable" | "degraded";

interface Outcome {
  state: "sent" | "queued" | "failed";
  lastStatus: number | null;
}

export function CaptureFlow({ vehicleId, taskId }: { vehicleId: string; taskId: string | null }) {
  const motive = useCaptureContext(vehicleId);

  // React state mirrors the draft for rendering; the draft in IndexedDB is the
  // truth (FR-OFF-005/006). Every mutation writes there first and updates this
  // to match, never the other way round — a reload has to find the work.
  const [draft, setDraft] = useState<Draft | null>(null);
  const [resumed, setResumed] = useState(false);
  const [held, setHeld] = useState<Draft | null>(null);
  const [screen, setScreen] = useState<Screen>("start");
  const [attachedIds, setAttachedIds] = useState<string[] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [storageFault, setStorageFault] = useState<StorageFault | null>(null);
  // Bumped by the retry below to re-run the draft load. FR-OFF-013 asks for a
  // supported recovery action, and for a browser mode the action is a person
  // changing something and trying again — which is only an offer if something
  // actually re-attempts.
  const [storageAttempt, setStorageAttempt] = useState(0);
  // Frozen at mount, for the same reason CaptureStart freezes its own: the
  // diagram asks severityOf once per cell on every render, and a wear-rate
  // comparison must not depend on when React happened to re-render. Day
  // granularity, so an inspection's lifetime cannot move it.
  const [openedAt] = useState(() => Date.now());

  // FR-OFF-006 / NFR-USE-011: a remount is a reload — a killed browser, a
  // phone call, a driver returning after lunch — and it has to find the work.
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

  // FR-INS-062's "defaulting to the last recorded composition": the rig a
  // CONTROLLER set, pre-ticked for the driver to confirm. Seeded with EVERY
  // member id — the motive unit is a member of its own combination and its
  // checkbox is disabled, so seeding only the trailers renders the driver's
  // own truck as not-here and unfixable.
  //
  // Derived rather than seeded into state by an effect: the default is a pure
  // function of the served composition, and writing it back would make the
  // first render's value a render of its own. It waits for the draft load,
  // which may narrow it to what a resumed inspection actually observed —
  // fetching a member the draft has already dropped costs a request on a depot
  // connection.
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
  const byId = new Map(rig.map((r) => [r.position.id, r]));
  const donePositionIds = draft ? capturedPositionIds(draft) : new Set<string>();
  const units = contexts ? completenessByUnit(contexts, donePositionIds) : [];
  const doneCount = units.reduce((n, u) => n + u.done, 0);
  // The submit payload's denominator and the figure on screen, from one
  // expression. Two derivations drift, and when they do the driver reads
  // "10 of 10 done" off an inspection the server has recorded as 83% complete
  // (payload.ts, completeness_pct).
  const totalPositions = units.reduce((n, u) => n + u.total, 0);
  const motiveCtx = contexts?.find((c) => c.vehicleId === vehicleId) ?? contexts?.[0];
  const active = activeId === null ? undefined : byId.get(activeId);

  // Recomputed from the readings rather than read off draft.positions[].
  // warnings: those are written only when a position is finished, so a
  // position saved mid-entry (FR-OFF-005 writes on the first digit) carries an
  // empty list and would draw on the diagram as though it had nothing to flag.
  //
  // Banded on treadsRead — the same predicate the header count, the tallies and
  // the payload use. Requiring a pressure here as well would draw a
  // tread-complete position with no pressure as "Not done" while the header
  // above it counted the same position as done, and would hide FR-INS-036 on a
  // cell the app has every number it needs to raise.
  function severityOf(positionId: string): Severity {
    const saved = draft?.positions[positionId];
    const r = byId.get(positionId);
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

  function governingOf(positionId: string): number | null {
    return governingTread(draft?.positions[positionId]?.treads ?? []);
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

  // FR-OFF-005: written as it is typed, not when the position is finished.
  // PositionSheet fires this once per keystroke and once more for the
  // auto-advance's own field change, with an identical payload — a redundant
  // rewrite of the same row, which is why nothing may depend on the count.
  function handleChange(position: DraftPosition) {
    setDraft((d) =>
      d ? { ...d, positions: { ...d.positions, [position.positionId]: position } } : d,
    );
    void savePosition(position).catch(() => setStorageFault("degraded"));
  }

  function handleDone(position: DraftPosition) {
    handleChange(position);
    setActiveId(null);
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
            ? { state: "sent", lastStatus: null }
            : {
                state: still.state === "failed" ? "failed" : "queued",
                lastStatus: still.lastStatus,
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
    body = <CaptureDone state={outcome.state} lastStatus={outcome.lastStatus} />;
  } else if (!resumed || motive.isPending) {
    body = <p className="cap-wait">Loading…</p>;
  } else if (held) {
    body = (
      <section className="cap-screen">
        <p role="alert" className="cap-alert cap-alert--stop">
          An inspection for another vehicle is still open on this phone. Finish that one first.
        </p>
        <a className="cap-primary" href={`/capture/${held.vehicleId}`}>
          Go to it
        </a>
      </section>
    );
  } else if (motive.isError || !motive.data) {
    // NFR-AVL-002: starting requires the server. Capture and submit do not, but
    // a driver must not start against reference data that never arrived — every
    // threshold would be missing and every warning would silently never fire.
    body = (
      <section className="cap-screen">
        <p role="alert" className="cap-alert cap-alert--stop">
          Could not load this vehicle. Find signal and try again.
        </p>
        <button type="button" className="cap-primary" onClick={() => void motive.refetch()}>
          Try again
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
          Could not load the rest of the rig. Find signal and try again — your readings are saved.
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
        donePositionIds={donePositionIds}
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
          onOpen={setActiveId}
          activeId={activeId}
        />

        <button type="button" className="cap-primary" onClick={() => setScreen("review")}>
          Review and submit ›
        </button>

        {/* Laid over the diagram rather than replacing it: the active cell is
          the driver's place-keeper across 27 positions, and remounting the
          picture on every position is both slower and a new screen to
          re-read. Keyed on the position so reopening one gets a fresh sheet
          seeded from the draft rather than the previous position's state. */}
        {active && (
          <div className="cap-sheet-layer">
            <PositionSheet
              key={active.position.id}
              rig={active}
              ctx={active.context}
              initial={draft.positions[active.position.id]}
              onChange={handleChange}
              onDone={handleDone}
              onClose={() => setActiveId(null)}
            />
          </div>
        )}
      </section>
    );
  }

  // Above every branch, not inside one: the fault is set from four places and
  // the driver can be on any of the four screens when it fires. Nested in one
  // branch, a Start button that throws and a submit that fails while review
  // re-renders are both silent.
  //
  // "degraded" stays non-blocking — the readings are on screen and still
  // submittable the moment storage comes back, so replacing the screen would
  // take away the only copy of the driver's work.
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
            <button type="button" className="cap-secondary" onClick={retryStorage}>
              Try again
            </button>
          )}
        </div>
      )}
      {body}
    </>
  );
}

// Walk order, which is the combination's own sequence — the projection has to
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
