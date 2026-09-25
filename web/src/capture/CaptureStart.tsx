import { useState } from "react";

import type { CaptureContext } from "./captureContext";
import { odometerRejection, odometerWarnings, projectedOdometerKm } from "./history";
import type { RecordedWarning } from "./draft";
import { Keypad } from "./Keypad";
import { groupThousands } from "../format/groupThousands";
import "./capture.css";

// The keypad's granularity is the field's own unit (whole km), never the
// tenant's tread granularity: at 0.5mm that would put a half key on a
// kilometre reading.
const ODOMETER_GRANULARITY_KM = 1.0;

// Seven digits covers 9,999,999km, past any unit's life; an eighth is a
// mis-tap that would break the readout FR-INS-033 argues from.
const ODOMETER_MAX_DIGITS = 7;

// Served unit kinds in driver words. An unknown kind falls back to the
// server's own token, not a guess: the vocabulary is the server's
// (captureContext.ts).
const UNIT_WORD: Record<string, string> = {
  HORSE: "Horse",
  TRAILER: "Trailer",
  RIGID: "Rigid",
  LIGHT: "Light vehicle",
};
const unitWord = (kind: string) => UNIT_WORD[kind] ?? kind;

export function CaptureStart({
  motive,
  storageBlocked,
  attachedIds,
  onToggleAttached,
  onStart,
}: {
  // The unit the driver navigated to. FR-INS-064: only the motive unit's
  // odometer is recorded, and distance is never apportioned to a towed one.
  motive: CaptureContext;
  // The device blocks writes entirely: nowhere to put an inspection.
  // CaptureFlow carries the reason and retry above; this control just stops
  // looking live (NFR-USE-005).
  storageBlocked: boolean;
  // Ticked members seeded from ALL of motive.combination.members (motive
  // included, disabled), narrowed only by unticking.
  attachedIds: string[];
  onToggleAttached: (vehicleId: string) => void;
  onStart: (init: {
    odometerKm: number | null;
    observedMemberVehicleIds: string[];
    warnings: RecordedWarning[];
  }) => void;
}) {
  // What the driver typed. Empty means they typed nothing, which is not the
  // same as an empty field: the screen may still be showing a projection.
  const [typed, setTyped] = useState("");
  // FR-INS-020 records CONFIRMED values only; this flag is the confirmation,
  // set only by the driver's tap. Defaulting true would record a number
  // nobody read (NFR-PRO-003).
  const [accepted, setAccepted] = useState(false);
  // FR-INS-033: warn and REQUIRE confirmation. A pre-checked box satisfies
  // the control without the driver acting on it. Separate from accepted:
  // one confirms WHAT, the other confirms an implausible jump is real.
  const [plausible, setPlausible] = useState(false);
  // Frozen at mount: this screen is open seconds and nothing on it is
  // finer than day granularity, so the clock must not depend on when React
  // re-renders (FR-INS-033's denominator included).
  const [openedAt] = useState(() => Date.now());

  // FR-INS-020's three clauses in one expression: typed is a correction,
  // tapped is acceptance, else the odometer is absent. Every check reads
  // this, so an unconfirmed projection gates and blocks nothing.
  const projected = projectedOdometerKm(motive, new Date(openedAt));
  const value = typed !== "" ? parseInt(typed, 10) : accepted ? projected : null;
  const rejection = odometerRejection(value, motive);
  const warnings = odometerWarnings(value, motive, new Date(openedAt));
  // What the readout shows: the driver's digits, else the projection offered
  // for confirmation, else nothing. Dimmed until it is the recorded value, so
  // a provisional number never looks like an entered one (NFR-USE-005).
  const shown = typed !== "" ? typed : projected !== null ? String(projected) : "";
  // FR-INS-020: optional, gated on what the unit IS, not on history. No
  // vehicle has a reading until the first inspection, so gating on history
  // would leave the timeline unstartable.
  const wantsOdometer = motive.unitKind !== "TRAILER";
  const held = warnings.length > 0 && !plausible;

  function start() {
    if (rejection) return;
    if (held) return;
    onStart({
      odometerKm: wantsOdometer ? value : null,
      // attachedIds already contains the disabled, ticked motive unit;
      // prepending it again would send a duplicate into FR-INS-063's
      // entered_value.
      observedMemberVehicleIds: attachedIds,
      // FR-INS-033's confirmation governs capture; DR-020 governs the
      // timeline. A confirmed implausible value submits and is preserved
      // on the warning record, not written to the append-only timeline
      // (DR-018).
      warnings: warnings.map((w) => ({
        code: w.code,
        enteredValue: w.enteredValue,
        response: "CONFIRMED" as const,
      })),
    });
  }

  return (
    <section className="cap-screen" aria-labelledby="start-heading">
      <header className="cap-screen-head">
        <p className="cap-eyebrow">{unitWord(motive.unitKind)}</p>
        <h1 id="start-heading" className="cap-screen-title">
          {motive.fleetNumber}
        </h1>
        <p className="cap-screen-sub">{motive.positions.length} positions on this unit</p>
      </header>

      {/* FR-INS-062: the driver confirms the rig, never composes it;
          unticking is FR-INS-063's observation, travelling as
          observed_member_vehicle_ids for a controller to reconcile.
          Nothing here writes fleet state. */}
      {motive.combination && (
        <fieldset className="cap-card">
          <legend className="cap-eyebrow">Your rig</legend>
          <p className="cap-hint">Confirm what is coupled up. Untick anything that is not here.</p>
          <ul className="cap-members">
            {motive.combination.members.map((m) => (
              <li key={m.vehicleId}>
                <label className="cap-member">
                  <input
                    type="checkbox"
                    className="cap-check"
                    checked={attachedIds.includes(m.vehicleId)}
                    disabled={m.vehicleId === motive.vehicleId}
                    onChange={() => onToggleAttached(m.vehicleId)}
                  />
                  <span className="cap-member-id">{m.fleetNumber}</span>
                  {m.descriptor && <span className="cap-member-note">{m.descriptor}</span>}
                </label>
              </li>
            ))}
          </ul>
          <p className="cap-hint">
            Something else coupled up? Finish this inspection and tell the office. They set the rig.
          </p>
        </fieldset>
      )}

      {wantsOdometer && (
        <fieldset className="cap-card">
          <legend className="cap-eyebrow">Odometer</legend>
          {/* Grouped in threes, the way the instrument reads, with the comma
              every displayed number uses (U55): a driver transcribing six
              digits from a dial in the sun has nothing to check their place
              against ungrouped. */}
          <p className={`cap-odo${value === null ? " is-empty" : ""}`} aria-live="polite">
            {shown === "" ? "000,000" : groupThousands(shown)}
            <span className="cap-odo-unit">km</span>
          </p>
          <p className="cap-hint">
            {motive.lastOdometerKm === null
              ? "No reading on record yet. This one starts the count."
              : `Last reading ${groupThousands(String(motive.lastOdometerKm))} km`}
            {motive.lastOdometerAt
              ? `, ${Math.round((openedAt - Date.parse(motive.lastOdometerAt)) / 86_400_000)} days ago`
              : ""}
          </p>
          {/* The confirm half of "confirm or correct" (FR-INS-020): one tap,
              the label carries the number so agreement is informed.
              Disappears once the value is the driver's. */}
          {value === null && projected !== null && (
            <button type="button" className="cap-secondary" onClick={() => setAccepted(true)}>
              Confirm {groupThousands(String(projected))} km
            </button>
          )}
          {value === null && projected !== null && (
            <p className="cap-hint">
              Worked out from that reading and this unit&rsquo;s usual daily distance. Check it
              against the dash. Confirm it, type the real number, or skip it.
            </p>
          )}
          <Keypad
            granularityMm={ODOMETER_GRANULARITY_KM}
            goLabel="Done ›"
            goTone="default"
            onKey={(k) => {
              // Typing supersedes the projection rather than editing it: the
              // driver is reading six digits off a dial, and appending to a
              // number they did not enter is how a transcription becomes a
              // hybrid of two readings.
              if (k.type === "digit") {
                setAccepted(false);
                setTyped((o) => (o.length >= ODOMETER_MAX_DIGITS ? o : o + k.digit));
              }
              if (k.type === "delete") {
                setAccepted(false);
                setTyped("");
              }
              // The go key is the largest control on the keypad. Leaving it
              // inert here would train a driver to distrust it on the entry
              // sheet, where it is pressed once per position.
              if (k.type === "next") start();
            }}
          />
          {/* FR-INS-032 is a rejection, not a warning: BR-INS-002 is
              unconditional, so refusing here saves the driver discovering it
              after the walk-around. */}
          {rejection && (
            <p role="alert" className="cap-alert cap-alert--stop">
              {rejection}
            </p>
          )}
          {warnings.map((w) => (
            <label key={w.code} className="cap-confirm">
              <input
                type="checkbox"
                className="cap-check"
                checked={plausible}
                onChange={(e) => setPlausible(e.target.checked)}
              />
              <span>
                <span className="cap-confirm-msg">{w.message}</span>
                <span className="cap-hint">Tick to confirm the reading is right.</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {/* NFR-PRV-006, erratum CS-2: most drivers use their own phone.
          draft.test.ts keeps the inspection half true; the device id is
          payload.ts's (NFR-OBS-004). */}
      <p className="cap-notice">
        While you are working, this inspection is saved on your phone, along with a random code that
        identifies the phone to the platform, not you. Nothing else about the fleet is stored here.
      </p>

      <button
        type="button"
        className="cap-primary"
        onClick={start}
        disabled={storageBlocked || rejection !== null || held}
      >
        Start inspection
      </button>
    </section>
  );
}
