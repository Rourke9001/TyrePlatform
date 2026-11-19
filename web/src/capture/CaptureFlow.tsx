import type { ReactNode } from "react";
import { useState } from "react";

import { ApiError } from "../api/apiError";
import { bearerMode, stampSubject } from "../api/token";
import { ACCESS_COPY, failureOf } from "../auth/actorContext";
import { SignInButton } from "../auth/SignInButton";
import { Button } from "../ui/Button";
import { inertOutside } from "../ui/inertOutside";

import { CaptureDiagram } from "./CaptureDiagram";
import { BackToWork, CaptureDone } from "./CaptureDone";
import { CaptureReview } from "./CaptureReview";
import { CaptureStart } from "./CaptureStart";
import { ConfirmDiscard } from "./ConfirmDiscard";
import type { RecordedWarning } from "./draft";
import { saveHeader } from "./draft";
import { useCaptureContext } from "./captureContext";
import { attemptSend, listOutbox, mayCarry, queueDraft } from "./outbox";
import { lostWords, draftLostWords } from "./lostWords";
import { appVersion, deviceId } from "./payload";
import { PositionSheet } from "./PositionSheet";
import { deriveProgress } from "./rig";
import { useTenantDate } from "../time/tenantTime";
import { useUnitLabels } from "../units/units";
import { useDraftLifecycle } from "./useDraftLifecycle";
import { useEntryHandlers } from "./useEntryHandlers";
import { inspectionEnded, useStorageFaults, writeFailed } from "./storageFaults";
import { useRigComposition } from "./useRigComposition";
import "./capture.css";

interface Outcome {
  state: "sent" | "queued" | "failed";
  lastCode: string | null;
  lastStatus: number | null;
  stampHeld: boolean;
}

// NFR-USE-005: a 403 answers the same on every reload, so it says who can
// change it (TYRE-329). On this read a 403 "forbidden" is a vehicle outside
// the driver's capture set (ADR-0006), not the unset account failureOf
// takes it for on GET /api/me.
function refusalWords(error: unknown, what: string): string | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null;
  if (error.code === "tenant_inactive") return ACCESS_COPY["tenant-inactive"].body;
  if (error.code === "not_provisioned") return ACCESS_COPY["not-set-up"].body;
  return `You do not have permission to inspect ${what}. Ask your fleet office to check you are assigned to it.`;
}

type Answer = { kind: "refused" | "unavailable"; said: string } | { kind: "signed-out" | "signal" };

// The four answers a capture read can get, for the motive and for the rig's
// members alike: a refusal says who can change it; a signed-out driver signs
// in; the token store's latch clears only on a page reload (apiError.ts); the
// rest is signal. LoadFailure and RefreshNotice both read it, so the two
// presentations cannot drift (TYRE-334). TYRE-465 makes this one table for
// every capture screen.
function answerOf(error: unknown, refused: string): Answer {
  const refusal = refusalWords(error, refused);
  if (refusal !== null) return { kind: "refused", said: refusal };
  const failure = failureOf(error);
  if (failure === "unavailable") {
    return { kind: "unavailable", said: ACCESS_COPY.unavailable.body };
  }
  return { kind: failure === "signed-out" ? "signed-out" : "signal" };
}

// The notice takes the member answer "Reload rig" cannot clear, wherever it
// sits in the walk: a refusal (spec section 1, case 3), then the token store's
// latch, which only a page reload clears (apiError.ts).
function memberNoticeError(stale: readonly { error: unknown }[]): unknown {
  const first = (kind: Answer["kind"]) =>
    stale.find((m) => answerOf(m.error, "a unit on this rig").kind === kind);
  return (first("refused") ?? first("unavailable") ?? stale[0])?.error;
}

function AnswerControls({
  answer,
  reloadLabel,
  onReload,
  emphasis,
}: {
  answer: Answer;
  reloadLabel: string;
  onReload: () => void;
  emphasis: "primary" | "secondary";
}) {
  const block = emphasis === "primary";
  if (answer.kind === "refused") return <BackToWork />;
  if (answer.kind === "unavailable") {
    return (
      <Button
        variant={emphasis}
        size="glove"
        block={block}
        onClick={() => window.location.reload()}
      >
        Try again
      </Button>
    );
  }
  const signedOut = answer.kind === "signed-out";
  return (
    <>
      {signedOut && bearerMode() && <SignInButton label="Sign in" />}
      <Button
        variant={signedOut ? "secondary" : emphasis}
        size="glove"
        block={block}
        onClick={onReload}
      >
        {reloadLabel}
      </Button>
    </>
  );
}

// U179, TYRE-334: a refresh failed and the copy stands. A status, not an
// alert, and it moves no focus: the driver can still start.
function RefreshNotice({
  error,
  refused,
  subject,
  copyAt,
  reloadLabel,
  onReload,
}: {
  error: unknown;
  refused: string;
  subject: string;
  copyAt: number;
  reloadLabel: string;
  onReload: () => void;
}) {
  const tenantDate = useTenantDate();
  const answer = answerOf(error, refused);
  const shows = `Showing the copy from ${tenantDate(new Date(copyAt))}.`;
  let sentence: string;
  if (answer.kind === "refused" || answer.kind === "unavailable") {
    sentence = `${answer.said} ${shows}`;
  } else if (answer.kind === "signed-out") {
    sentence = `Sign in to refresh ${subject}. ${shows}`;
  } else {
    sentence = `Could not refresh ${subject}. ${shows} Find signal, then reload.`;
  }
  return (
    <div role="status" className="cap-alert cap-alert--caution cap-refresh">
      <p className="cap-refresh-msg">{sentence}</p>
      <AnswerControls
        answer={answer}
        reloadLabel={reloadLabel}
        onReload={onReload}
        emphasis="secondary"
      />
    </div>
  );
}

function LoadFailure({
  error,
  refused,
  loading,
  saved,
  reloadLabel,
  onReload,
}: {
  error: unknown;
  refused: string;
  loading: string;
  saved: boolean;
  reloadLabel: string;
  onReload: () => void;
}) {
  const answer = answerOf(error, refused);
  const reason =
    answer.kind === "refused" || answer.kind === "unavailable"
      ? answer.said
      : answer.kind === "signed-out"
        ? `Sign in to load ${loading}.`
        : `Could not load ${loading}. Find signal and try again.`;
  return (
    <section className="cap-screen">
      <p role="alert" className="cap-alert cap-alert--stop">
        {reason}
        {saved && " Your readings are saved."}
      </p>
      <AnswerControls
        answer={answer}
        reloadLabel={reloadLabel}
        onReload={onReload}
        emphasis="primary"
      />
    </section>
  );
}

export function CaptureFlow({ vehicleId, taskId }: { vehicleId: string; taskId: string | null }) {
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
  // Frozen at mount: severityOf runs once per cell per render, and a
  // wear-rate comparison must not move with a re-render.
  const [openedAt] = useState(() => Date.now());

  const lifecycle = useDraftLifecycle(vehicleId, taskId, setActiveKey, setAttachedIds);
  const { draft, setDraft, resumed, held, screen, setScreen } = lifecycle;
  const faults = useStorageFaults();
  // Read once the draft has loaded, so a resumed draft's units are keyed on
  // its own window and never asked of the server first at now (U148); the
  // seed in captureContext.ts says what that key serves.
  const startedAt = lifecycle.resumedStartedAt ?? undefined;
  const motive = useCaptureContext(vehicleId, startedAt, resumed);

  // U186: past the start screen, the walk-around and the review read held contexts.
  const rigComp = useRigComposition(
    motive.data,
    vehicleId,
    resumed,
    attachedIds,
    setAttachedIds,
    startedAt,
    screen !== "start",
    draft?.startedAt,
    draft?.combinationId,
  );
  const {
    confirmedIds,
    contexts,
    heldMotive,
    membersError,
    membersRefreshing,
    refetchMembers,
    staleMembers,
    refetchStaleMembers,
    toggleAttached,
  } = rigComp;
  const shownMotive = heldMotive ?? motive.data;
  // A failure is read only with no data, so a copy outlives a failed refresh
  // (U179); the start screen says so in a notice (TYRE-334).
  const vehicleStale = motive.isError && motive.data !== undefined;

  // The tenant's unit words, read once for every position's warnings.
  const labels = useUnitLabels();
  const progress = deriveProgress(contexts, draft, openedAt, labels);
  const { doneCells, absent, units, doneCount, totalPositions, severityOf, governingOf } = progress;
  const motiveCtx = contexts?.find((c) => c.vehicleId === vehicleId) ?? contexts?.[0];
  const active = activeKey === null ? undefined : progress.byCell.get(activeKey);

  const { handleChange, handleDone, handleAbsent } = useEntryHandlers({
    setDraft,
    setActiveKey,
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
    rigComp.hold();
    void lifecycle.startDraftAndAdvance(ctx, init);
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
        // Queued: the inspection is off the draft, so a warning about its
        // writes has nothing left to warn of (TYRE-339).
        inspectionEnded();
        await attemptSend(entry.clientUuid);
        // The queue, not the response, decides what the driver is told: a
        // dead network and a refusal reach here the same way and mean
        // opposite things (FR-OFF-012 vs FR-OFF-013).
        const still = (await listOutbox()).find((e) => e.clientUuid === entry.clientUuid);
        setOutcome(
          still === undefined
            ? { state: "sent", lastCode: null, lastStatus: null, stampHeld: false }
            : {
                state: still.state === "failed" ? "failed" : "queued",
                lastCode: still.lastCode ?? null,
                lastStatus: still.lastStatus,
                stampHeld: !mayCarry(still, stampSubject()),
              },
        );
        setDraft(null);
        setScreen("done");
      } catch {
        // An inspection is in hand and still on screen, so this is recoverable
        // in a way the pre-start case is not.
        writeFailed();
        setSubmitting(false);
      }
    })();
  }

  let body: ReactNode;
  if (screen === "done" && outcome) {
    body = (
      <CaptureDone
        state={outcome.state}
        lastCode={outcome.lastCode}
        lastStatus={outcome.lastStatus}
        stampHeld={outcome.stampHeld}
      />
    );
  } else if (
    !resumed ||
    // A held motive does not wait on its query (U186).
    (heldMotive === undefined && motive.isPending) ||
    // Only the start screen waits on a stale copy that is fetching (U179, U186).
    (screen === "start" &&
      ((motive.data !== undefined && motive.isStale && motive.isFetching) || membersRefreshing))
  ) {
    body = <p className="cap-wait">Loading…</p>;
  } else if (lifecycle.otherDriverHeld) {
    body = (
      <section className="cap-screen">
        <p role="alert" className="cap-alert cap-alert--stop">
          Another driver has an inspection open on this phone. They need to sign in here and finish
          it before anyone else can start one.
        </p>
        <BackToWork />
      </section>
    );
  } else if (held) {
    const heldName = held.fleetNumber ?? "the other vehicle";
    body = (
      <section className="cap-screen">
        <p role="alert" className="cap-alert cap-alert--stop">
          An inspection for another vehicle is still open on this phone. Finish that one first.
        </p>
        {/* A plain anchor for BackToWork's reason (CaptureDone.tsx). */}
        <a className="cap-primary" href={`/capture/${held.vehicleId}`}>
          Go to it
        </a>
        <ConfirmDiscard
          trigger="Discard it"
          question={`Discard the inspection of ${heldName}?`}
          consequence={draftLostWords(held)}
          confirm="Discard"
          onConfirm={lifecycle.discardHeld}
        />
      </section>
    );
  } else if (!shownMotive) {
    // NFR-AVL-002: starting requires the server; every threshold and
    // warning depends on data that must have arrived. The storage-unavailable
    // alert is hoisted so its retry can sit beside this screen's own, each
    // naming its own action.
    body = (
      <LoadFailure
        error={motive.error}
        refused="this vehicle"
        loading="this vehicle"
        saved={false}
        reloadLabel="Reload vehicle"
        onReload={() => void motive.refetch()}
      />
    );
  } else if (
    screen === "start" &&
    vehicleStale &&
    answerOf(motive.error, "this vehicle").kind === "refused"
  ) {
    // The owner's answer of 19 Nov 2026: a refused vehicle stops the start
    // screen as a first load does. The copy stays cached, and a later success
    // restores Start.
    body = (
      <LoadFailure
        error={motive.error}
        refused="this vehicle"
        loading="this vehicle"
        saved={false}
        reloadLabel="Reload vehicle"
        onReload={() => void motive.refetch()}
      />
    );
  } else if (screen === "start") {
    const failedAt = [
      ...(vehicleStale ? [motive.dataUpdatedAt] : []),
      ...staleMembers.map((m) => m.copyAt),
    ];
    body = (
      <>
        {failedAt.length > 0 && (
          <RefreshNotice
            error={vehicleStale ? motive.error : memberNoticeError(staleMembers)}
            refused={vehicleStale ? "this vehicle" : "a unit on this rig"}
            subject={vehicleStale ? "this vehicle" : "the rest of the rig"}
            copyAt={Math.min(...failedAt)}
            reloadLabel={vehicleStale ? "Reload vehicle" : "Reload rig"}
            onReload={() => {
              if (vehicleStale) void motive.refetch();
              refetchStaleMembers();
            }}
          />
        )}
        <CaptureStart
          motive={shownMotive}
          storageBlocked={faults.unavailable}
          attachedIds={confirmedIds ?? [vehicleId]}
          onToggleAttached={toggleAttached}
          onStart={handleStart}
        />
      </>
    );
  } else if (membersError !== null) {
    body = (
      <LoadFailure
        error={membersError}
        refused="a unit on this rig"
        loading="the rest of the rig"
        saved
        reloadLabel="Reload rig"
        onReload={refetchMembers}
      />
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

        <Button variant="primary" size="glove" block onClick={() => setScreen("review")}>
          Review and submit ›
        </Button>

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
          seeded from the draft rather than the previous position's state.
          The layer hides the rig and the shell, so they take no focus while
          it is open (WCAG 2.4.11, ui/inertOutside.ts). */}
        {active && (
          <div className="cap-sheet-layer" ref={inertOutside}>
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
  // a fault fires. One banner shows at a time and "unavailable" takes it
  // (TYRE-339); "degraded" stays non-blocking, since the readings are still
  // on screen and submittable.
  return (
    <>
      {(faults.unavailable || faults.degraded) && (
        <div role="alert" className="cap-alert cap-alert--stop cap-storage">
          <p className="cap-storage-msg">
            {faults.unavailable
              ? "This phone is not letting the app save anything, so an inspection cannot be started. Private browsing or a work-phone setting usually causes this."
              : "This phone is not saving reliably. Keep the app open until this inspection has been sent."}
          </p>
          {faults.unavailable && (
            // Named for what it retries. See the load-failure branch above
            // for why both retries need distinct labels.
            <Button variant="secondary" size="glove" onClick={lifecycle.retryStorage}>
              Recheck storage
            </Button>
          )}
        </div>
      )}
      {lifecycle.signInNeeded && (
        <div className="cap-alert cap-alert--stop cap-signin">
          <p role="alert" className="cap-signin-msg">
            Sign in before you start an inspection.
          </p>
          {bearerMode() && <SignInButton label="Sign in" />}
        </div>
      )}
      {body}
    </>
  );
}
