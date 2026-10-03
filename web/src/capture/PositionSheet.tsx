import { useEffect, useMemo, useRef, useState } from "react";

import type { CaptureContext, CapturePosition } from "./captureContext";
import type { RigPosition } from "./rig";
import type { DraftPosition, RecordedWarning } from "./draft";
import type { EntryKey, EntryState } from "./entry";
import { applyKey, newEntryState } from "./entry";
import { governingTread, isComplete, positionWarnings, severityFor, treadsRead } from "./warnings";
import { historyWarnings } from "./history";
import { Keypad } from "./Keypad";
import { TreadGlyph } from "./TreadGlyph";
import "./capture.css";

// FR-INS-029a and decision D-A: numbered, not named. The driver never sees
// the words inner or outer, and the three fields sit left to right in the
// plan view, the same direction the diagram above them reads.
const FIELD_LABEL = (i: number, count: number) => `Tread reading ${i + 1} of ${count}`;

// The beat between the last digit that could change a field and the sheet
// acting on it, both the prototype's own numbers; longer off the pressure
// field since that hold ENDS the position.
const HOLD_MS = 200;
const PRESSURE_HOLD_MS = 450;

export function PositionSheet({
  rig,
  ctx,
  initial,
  onChange,
  onDone,
  onClose,
  absent,
  onAbsent,
}: {
  rig: RigPosition;
  ctx: CaptureContext;
  // FR-OFF-006: reopening a captured position shows what was entered, not an
  // empty form. The draft is the source of truth and this is how it gets back
  // onto the screen.
  initial?: DraftPosition;
  // FR-OFF-005: "every entry … written incrementally". Fired per keystroke,
  // not per completed position. The flat-battery case is mid-position.
  onChange: (partial: DraftPosition) => void;
  onDone: (position: DraftPosition) => void;
  onClose: () => void;
  // TYRE-155 / FR-INS-066: whether this spare is already marked absent, and
  // the toggle that marks or unmarks it. Both optional and both meaningless
  // off a spare sheet. A running position with no tyre is a fitment fact for
  // the register, never this.
  absent?: boolean;
  onAbsent?: (position: CapturePosition, absent: boolean) => void;
}) {
  const count = ctx.config.treadReadingCount;
  const [state, setState] = useState<EntryState>(() => {
    if (!initial) return newEntryState(count);
    // TYRE-148: the field a driver comes back to is the first one they have
    // not filled, NFR-USE-011's interrupted position, and on a position
    // with nothing left to fill, the first, so a reopen-to-look is unchanged.
    const firstEmpty = initial.treads.findIndex((t) => t === null);
    const field = firstEmpty !== -1 ? firstEmpty : initial.pressureKpa === null ? count : 0;
    return { treads: [...initial.treads], pressureKpa: initial.pressureKpa, field, buffer: "" };
  });
  const [acknowledged, setAcknowledged] = useState(false);
  // NFR-OBS-007. Wall clock from when the sheet opened, plus anything a
  // previous visit already cost. A driver who backs out and returns is
  // measured for both, which is the honest reading of "time per position".
  const [openedAt] = useState(() => Date.now());
  const carried = useRef(initial?.seconds ?? 0);

  const opts = { treadReadingCount: count, granularityMm: ctx.config.treadGranularityMm };
  const entry = { treads: state.treads, pressureKpa: state.pressureKpa };
  const warnings = useMemo(
    () => [
      ...positionWarnings(entry, rig.position, ctx.config),
      // Frozen at open, like CaptureFlow/CaptureStart/CaptureReview:
      // FR-INS-035's rate has elapsed time as its denominator, and a
      // render-time read would drift from the diagram's.
      ...historyWarnings(entry, rig.position, ctx, new Date(openedAt)),
    ],
    // entry is rebuilt from state every render, so depending on state (not
    // the fresh entry object) is what actually makes this a memo rather than
    // a recompute-on-every-render in disguise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, rig.position, ctx],
  );
  const complete = isComplete(entry, count);
  const held = complete && warnings.length > 0 && !acknowledged;

  // Object identity is not enough: applyKey returns a fresh state for a
  // focus tap too, so tapping to read looks like an edit, and treating it
  // as one let a look-and-leave visit overwrite a previous visit's
  // FR-INS-040 responses.
  function edited(from: EntryState): boolean {
    if (!initial) return from.treads.some((t) => t !== null) || from.pressureKpa !== null;
    return (
      from.pressureKpa !== initial.pressureKpa ||
      from.treads.length !== initial.treads.length ||
      from.treads.some((t, i) => t !== initial.treads[i])
    );
  }

  // Carries the previous visit's FR-INS-040 records forward: the
  // incremental save wholesale-replaces the draft position on every
  // keystroke, so an empty default would turn an ACKNOWLEDGED/CONFIRMED
  // warning into no record at all, a corruption that then submits into
  // append-only history.
  function snapshot(
    from: EntryState,
    recorded: RecordedWarning[] = initial?.warnings ?? [],
  ): DraftPosition {
    return {
      positionId: rig.position.id,
      vehicleId: rig.position.vehicleId,
      tyreId: rig.position.tyreId,
      treads: from.treads,
      pressureKpa: from.pressureKpa,
      pressureTemperature: "UNKNOWN",
      damageFlag: false,
      note: null,
      seconds: carried.current + Math.round((Date.now() - openedAt) / 1000),
      warnings: recorded,
    };
  }

  // FR-OFF-005 verbatim: written as typed. Runs after commit, not inline in
  // press(), since press() is called from a render loop and render must
  // stay pure. Guarded by object identity, not an invocation count, against
  // StrictMode's double-fire.
  const initialState = useRef(state);
  useEffect(() => {
    if (state === initialState.current) return;
    onChange(snapshot(state));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state carries treads/pressureKpa, rig/carried/openedAt are stable for the sheet's lifetime, and onChange is a prop deliberately excluded: the effect must fire on a state change, not on a parent re-render handing it a new closure.
  }, [state]);

  function press(key: EntryKey) {
    const result = applyKey(state, key, opts);
    setState(result.state);
    if (result.settled) scheduleAdvance(result.state);
  }

  // React 19 removed the argument-less useRef overload.
  const timer = useRef<number | undefined>(undefined);

  // Refreshed on every commit: the callback outlives the render that armed
  // it, so it must run this render's closure. Deliberately not a state
  // updater, since onDone would then fire twice under StrictMode and
  // record the position twice.
  const onHold = useRef<((atField: number, expected: number | null) => void) | undefined>(
    undefined,
  );

  function scheduleAdvance(from: EntryState) {
    window.clearTimeout(timer.current);
    const atField = from.field;
    const expected = atField >= count ? from.pressureKpa : from.treads[atField];
    timer.current = window.setTimeout(
      () => onHold.current?.(atField, expected),
      atField >= count ? PRESSURE_HOLD_MS : HOLD_MS,
    );
  }
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // FR-INS-040: walking away without answering is one of the answers the
  // record must hold. finish() records ACKNOWLEDGED/CONFIRMED; this writes
  // standing warnings with a null response only when a reading actually
  // moved, since an unchanged visit is checking, not walking away, and the
  // incremental save already stored that entry.
  function close() {
    if (edited(state)) {
      onChange(
        snapshot(
          state,
          warnings.map((w) => ({
            code: w.code,
            enteredValue: w.enteredValue,
            response: null,
          })),
        ),
      );
    }
    onClose();
  }

  function finish() {
    if (!complete) return;
    // FR-INS-040: the warning was displayed and the driver acted on it. One
    // tap does both. The alert has been on screen since the position
    // completed, so "Seen it" records the response and moves on, exactly as
    // the prototype's advance() does.
    if (held) setAcknowledged(true);
    const recorded: RecordedWarning[] = warnings.map((w) => ({
      code: w.code,
      enteredValue: w.enteredValue,
      response: w.requiresConfirmation ? "CONFIRMED" : "ACKNOWLEDGED",
    }));
    onDone(snapshot(state, recorded));
  }

  useEffect(() => {
    onHold.current = (atField, expected) => {
      if (state.field !== atField) return;
      // The prototype's holdThenAdvance guard, and the reason a fourth
      // pressure digit or a correction typed inside the beat is never
      // swallowed: if the value moved, the driver is still working.
      const now = atField >= count ? state.pressureKpa : state.treads[atField];
      if (now !== expected) return;
      if (atField < count) {
        setState(applyKey(state, { type: "next" }, opts).state);
        return;
      }
      // Off the pressure field the hold ends the position, the one place
      // FR-INS-040 could be defeated by a self-closing sheet; a clean
      // position closes itself instead, saving a tap against NFR-USE-001a.
      // The !complete half is wider than the prototype's deliberately:
      // finish() no-ops when incomplete, so it costs no taps.
      if (!complete || warnings.length > 0) return;
      finish();
    };
  });

  const governing = governingTread(state.treads);
  // Banded on the treads, like the diagram cell this sheet zooms in on: a
  // below-removal reading has to look urgent the moment it is legible, not
  // once a pressure the driver may never take has been typed.
  const severity = severityFor(warnings, treadsRead(state.treads));

  return (
    <section
      className="cap-sheet"
      // Named the way the diagram cell that opens it is named. A spare
      // carries no walk-around number, so naming it for its unit is the
      // only thing that tells them apart: every configuration has a spare
      // count, so a rig has one per unit (BR-VEH-003).
      aria-label={
        rig.displayNumber === null
          ? `Spare, ${rig.context.fleetNumber}`
          : `Position ${rig.displayNumber}`
      }
    >
      <header className="cap-sheet-head">
        <p className="cap-sheet-pos">
          {rig.displayNumber === null ? "Spare tyre" : `Position ${rig.displayNumber}`}
        </p>
        {/* FR-INS-026: the tyre identified from fitment state, shown for
            confirmation. FR-INS-027's dispute is a later ticket; the payload
            already carries whatever tyre id the driver was shown. */}
        <p className="cap-sheet-meta">
          {rig.context.fleetNumber} · {rig.position.axleClass.toLowerCase()}
          {rig.position.tyreCode ? ` · ${rig.position.tyreCode}` : ""}
        </p>
        <button type="button" className="cap-iconbtn" aria-label="Close" onClick={close}>
          ✕
        </button>
        {/* TYRE-155 / FR-INS-066: one tap, on the spare sheet only. It replaces
            the close tap a driver with no spare pays today, so the ledger is
            net zero; the observation rides to the server (000041). */}
        {rig.position.isSpare && onAbsent && (
          <button
            type="button"
            className="cap-secondary"
            onClick={() => onAbsent(rig.position, !absent)}
          >
            {absent ? "Spare is here" : "No spare on this unit"}
          </button>
        )}
      </header>

      {rig.position.side !== null && (
        <div className="cap-frame">
          <TreadGlyph side={rig.position.side} count={count} />
          {/* The one training sentence decision D-A promised (BR-VEH-001:
              "one diagram, one training message"). No inner/outer. */}
          <p className="cap-hint">Enter left to right, as seen from above.</p>
        </div>
      )}

      <div className="cap-fields">
        {state.treads.map((value, i) => (
          <button
            key={i}
            type="button"
            className={`cap-fld${state.field === i ? " is-on" : ""}`}
            aria-label={FIELD_LABEL(i, count)}
            // Which field is live, for a screen reader and for a test that
            // needs to wait for the auto-advance rather than race it.
            aria-current={state.field === i ? "true" : undefined}
            onClick={() => press({ type: "focus", field: i })}
          >
            <span className="cap-fld-k">{i + 1}</span>
            <span className="cap-fld-u">mm</span>
            <span className={`cap-fld-v${value === null ? " is-empty" : ""}`}>{value ?? "–"}</span>
          </button>
        ))}
        <button
          type="button"
          className={`cap-fld${state.field === count ? " is-on" : ""}`}
          aria-label="Pressure"
          aria-current={state.field === count ? "true" : undefined}
          onClick={() => press({ type: "focus", field: count })}
        >
          <span className="cap-fld-k">Press.</span>
          <span className="cap-fld-u">kPa</span>
          <span className={`cap-fld-v${state.pressureKpa === null ? " is-empty" : ""}`}>
            {state.pressureKpa ?? "–"}
          </span>
        </button>
      </div>

      <div className="cap-alerts">
        {warnings.map((w) => (
          <p key={w.code} role="alert" className={`cap-alert cap-alert--${severity}`}>
            {w.message}
          </p>
        ))}
        {complete && warnings.length === 0 && (
          <p className="cap-alert cap-alert--ok">Nothing to flag ({governing}mm).</p>
        )}
      </div>

      <Keypad
        // Next advances while the position is unfinished and finishes it
        // once it is complete. Wiring it straight to finish() strands a
        // 0-3mm tread: those never settle (30 is still under the 35mm
        // ceiling, so another digit is possible), finish() returns early on
        // an incomplete position, and the driver has no way forward, on
        // the exact reading the product exists to catch.
        onKey={(k) => (k.type === "next" && complete ? finish() : press(k))}
        granularityMm={ctx.config.treadGranularityMm}
        goLabel={held ? "Seen it ›" : complete ? "Done ›" : "Next ›"}
        goTone={held ? "warn" : "default"}
      />
    </section>
  );
}
