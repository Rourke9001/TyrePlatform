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
import { governingTread, positionWarnings, severityFor } from "./warnings";
import "./capture.css";

type Screen = "start" | "capture" | "review" | "done";

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
  const [storageFailed, setStorageFailed] = useState(false);

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
        setStorageFailed(true);
        setResumed(true);
      },
    );
    return () => {
      dropped = true;
    };
  }, [vehicleId]);

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
  function severityOf(positionId: string): Severity {
    const saved = draft?.positions[positionId];
    const r = byId.get(positionId);
    if (!saved || !r) return "unmeasured";
    const entry = { treads: saved.treads, pressureKpa: saved.pressureKpa };
    const complete =
      saved.treads.length === r.context.config.treadReadingCount &&
      saved.treads.every((t) => t !== null) &&
      saved.pressureKpa !== null;
    return severityFor(
      [
        ...positionWarnings(entry, r.position, r.context.config),
        ...historyWarnings(entry, r.position, r.context, new Date()),
      ],
      complete,
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
        setStorageFailed(true);
      }
    })();
  }

  // FR-OFF-005: written as it is typed, not when the position is finished.
  // PositionSheet fires this once per keystroke and once more for the
  // auto-advance's own field change, with an identical payload — a redundant
  // rewrite of the same row, which is why nothing may depend on the count.
  function handleChange(position: DraftPosition) {
    setDraft((d) =>
      d ? { ...d, positions: { ...d.positions, [position.positionId]: position } } : d,
    );
    void savePosition(position).catch(() => setStorageFailed(true));
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
          // The motive unit's configured granularity, stamped on every reading
          // (FR-INS-021). A rig whose members are configured differently would
          // mislabel the towed unit's readings; the payload carries one value
          // for the inspection (payload.ts).
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
        setStorageFailed(true);
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

  if (screen === "done" && outcome) {
    return <CaptureDone state={outcome.state} lastStatus={outcome.lastStatus} />;
  }

  if (!resumed || motive.isPending) {
    return <p className="cap-wait">Loading…</p>;
  }

  if (held) {
    return (
      <section className="cap-screen">
        <p role="alert" className="cap-alert cap-alert--stop">
          An inspection for another vehicle is still open on this phone. Finish that one first.
        </p>
        <a className="cap-primary" href={`/capture/${held.vehicleId}`}>
          Go to it
        </a>
      </section>
    );
  }

  // NFR-AVL-002: starting requires the server. Capture and submit do not, but
  // a driver must not start against reference data that never arrived — every
  // threshold would be missing and every warning would silently never fire.
  if (motive.isError || !motive.data) {
    return (
      <section className="cap-screen">
        <p role="alert" className="cap-alert cap-alert--stop">
          Could not load this vehicle. Find signal and try again.
        </p>
        <button type="button" className="cap-primary" onClick={() => void motive.refetch()}>
          Try again
        </button>
      </section>
    );
  }

  if (screen === "start") {
    return (
      <CaptureStart
        motive={motive.data}
        attachedIds={confirmedIds ?? [vehicleId]}
        onToggleAttached={toggleAttached}
        onStart={handleStart}
      />
    );
  }

  if (membersFailed) {
    return (
      <section className="cap-screen">
        <p role="alert" className="cap-alert cap-alert--stop">
          Could not load the rest of the rig. Find signal and try again — your readings are saved.
        </p>
      </section>
    );
  }

  if (!contexts || !draft) {
    return <p className="cap-wait">Loading…</p>;
  }

  if (screen === "review") {
    return (
      <CaptureReview
        contexts={contexts}
        draft={draft}
        donePositionIds={donePositionIds}
        onBack={() => setScreen("capture")}
        onSubmit={handleSubmit}
      />
    );
  }

  return (
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
        {storageFailed && (
          <p role="alert" className="cap-alert cap-alert--stop">
            This phone stopped saving. Finish and send now, before you close the app.
          </p>
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
