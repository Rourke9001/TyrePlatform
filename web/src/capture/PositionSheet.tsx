import { useEffect, useMemo, useRef, useState } from "react";

import type { CaptureContext } from "./captureContext";
import type { RigPosition } from "./rig";
import type { DraftPosition, RecordedWarning } from "./draft";
import type { EntryKey, EntryState } from "./entry";
import { applyKey, newEntryState } from "./entry";
import { governingTread, isComplete, positionWarnings, severityFor, treadsRead } from "./warnings";
import { historyWarnings } from "./history";
import { Keypad } from "./Keypad";
import "./capture.css";

// FR-INS-029a and decision D-A: numbered, not named. The driver never sees
// the words inner or outer, and the three fields sit left to right in the
// plan view — the same direction the diagram above them reads.
const FIELD_LABEL = (i: number, count: number) => `Tread reading ${i + 1} of ${count}`;

// The beat between the last digit that could still change a field and the sheet
// acting on it. Both are the prototype's own numbers, and it is longer off the
// pressure field for the reason it is longer there: that hold ENDS the
// position, so the driver gets to read the verdict before the next position
// takes the screen (driver_capture_prototype.html, holdThenAdvance's callers).
const HOLD_MS = 200;
const PRESSURE_HOLD_MS = 450;

export function PositionSheet({
  rig,
  ctx,
  initial,
  onChange,
  onDone,
  onClose,
}: {
  rig: RigPosition;
  ctx: CaptureContext;
  // FR-OFF-006: reopening a captured position shows what was entered, not an
  // empty form. The draft is the source of truth and this is how it gets back
  // onto the screen.
  initial?: DraftPosition;
  // FR-OFF-005: "every entry … written incrementally". Fired per keystroke,
  // not per completed position — the flat-battery case is mid-position.
  onChange: (partial: DraftPosition) => void;
  onDone: (position: DraftPosition) => void;
  onClose: () => void;
}) {
  const count = ctx.config.treadReadingCount;
  const [state, setState] = useState<EntryState>(() =>
    initial
      ? { treads: [...initial.treads], pressureKpa: initial.pressureKpa, field: 0, buffer: "" }
      : newEntryState(count),
  );
  const [acknowledged, setAcknowledged] = useState(false);
  // NFR-OBS-007. Wall clock from when the sheet opened, plus anything a
  // previous visit already cost — a driver who backs out and returns is
  // measured for both, which is the honest reading of "time per position".
  const [openedAt] = useState(() => Date.now());
  const carried = useRef(initial?.seconds ?? 0);

  const opts = { treadReadingCount: count, granularityMm: ctx.config.treadGranularityMm };
  const entry = { treads: state.treads, pressureKpa: state.pressureKpa };
  const warnings = useMemo(
    () => [
      ...positionWarnings(entry, rig.position, ctx.config),
      ...historyWarnings(entry, rig.position, ctx, new Date()),
    ],
    // entry is rebuilt from state every render, so depending on state (not
    // the fresh entry object) is what actually makes this a memo rather than
    // a recompute-on-every-render in disguise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, rig.position, ctx],
  );
  const complete = isComplete(entry, count);
  const held = complete && warnings.length > 0 && !acknowledged;

  function snapshot(from: EntryState, recorded: RecordedWarning[] = []): DraftPosition {
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

  // FR-OFF-005, the verbatim requirement: every entry, incrementally. A
  // half-entered position survives a killed browser because it was written
  // as it was typed, not when it was finished. This reads the wall clock, so
  // it runs after commit rather than inline in press() — press() is called
  // from field buttons rendered in a loop, and a render pass must stay a pure
  // function of state, never a source of a value like "now".
  //
  // Guarded by identity against the mount's own state, not by an
  // invocation count: main.tsx renders under StrictMode, which fires this
  // effect twice for the one commit, and a boolean flag would let the second
  // firing through — reporting an untouched position as an edited one.
  // Identity survives that because both firings see the same object.
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

  // What the hold does when it fires, refreshed on every commit (below, once
  // everything it reaches for is in scope). The callback outlives the render
  // that armed it by a fifth of a second or more, and by then the entry, the
  // standing warnings and the flow's own draft have all moved on — so it has
  // to run this render's closure, not that one's. It is also deliberately not
  // a state updater: off the pressure field it finishes the position, and an
  // updater that called onDone would be invoked twice under StrictMode and
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

  // FR-INS-040 asks what the driver DID about a warning, and walking away
  // without answering is one of the answers the record has to be able to hold.
  // finish() records ACKNOWLEDGED/CONFIRMED; this is the other exit, and it
  // writes the warnings still standing with a null response — the state at
  // exit, recomputed from the current entry, so a value the driver corrected
  // on the way leaves no unanswered record behind.
  //
  // Guarded on the same identity the incremental save uses: an untouched visit
  // must not overwrite the responses a previous, finished visit recorded.
  function close() {
    if (state !== initialState.current) {
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
    // tap does both — the alert has been on screen since the position
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
      // Off the pressure field the hold ends the position, which makes it the
      // one place FR-INS-040 can be defeated: a sheet that closed itself while
      // the driver was reading a warning would never record what they did
      // about it. So the guard is the prototype's own, and no wider — a
      // position with something to tell the driver waits for the tap that
      // answers it, and a clean one closes itself. That saved tap is paid on
      // every clean position, against NFR-USE-001a's seven minutes for a
      // 26-position combination.
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
    <section className="cap-sheet" aria-label={`Position ${rig.displayNumber ?? "spare"}`}>
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
      </header>

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
        // an incomplete position, and the driver has no way forward — on
        // the exact reading the product exists to catch.
        onKey={(k) => (k.type === "next" && complete ? finish() : press(k))}
        granularityMm={ctx.config.treadGranularityMm}
        goLabel={held ? "Seen it ›" : complete ? "Done ›" : "Next ›"}
        goTone={held ? "warn" : "default"}
      />
    </section>
  );
}
