import { useState } from "react";

import type { CaptureContext } from "./captureContext";
import { odometerRejection, odometerWarnings } from "./history";
import type { RecordedWarning } from "./draft";
import { Keypad } from "./Keypad";
import "./capture.css";

// The keypad reads a granularity for exactly one decision: at 0.5 the ½ key
// takes the delete key's slot (Keypad.tsx). An odometer is whole kilometres, so
// the ½ key must never appear here whatever a tenant's treadGranularityMm is,
// and a six-digit field needs delete far more than a two-digit one does. This
// is the unit of the field being typed, not a tenant threshold — passing the
// tread granularity through would put a ½ key on a kilometre reading for every
// tenant configured at 0.5mm.
const ODOMETER_GRANULARITY_KM = 1.0;

// Seven digits covers 9 999 999 km, well past the life of any unit in the
// fleet. An eighth is a mis-tap, and accepting it would break the readout a
// driver checks their place against for a value FR-INS-033 has to argue about
// afterwards.
const ODOMETER_MAX_DIGITS = 7;

// The served unit kinds, in the words a driver uses for them. An unknown kind
// falls back to the server's own token rather than to a guess: the vocabulary
// is the server's (captureContext.ts) and a client that cannot represent a new
// one should degrade, not mislabel.
const UNIT_WORD: Record<string, string> = {
  HORSE: "Horse",
  TRAILER: "Trailer",
  RIGID: "Rigid",
  LIGHT: "Light vehicle",
};
const unitWord = (kind: string) => UNIT_WORD[kind] ?? kind;

// Grouped in threes, the way the instrument itself reads. A driver is
// transcribing six digits from a dial into a phone in the sun; ungrouped they
// have nothing to check their place against.
const grouped = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, " ");

export function CaptureStart({
  motive,
  attachedIds,
  onToggleAttached,
  onStart,
}: {
  // The unit the driver navigated to. FR-INS-064: only the motive unit's
  // odometer is recorded, and distance is never apportioned to a towed one.
  motive: CaptureContext;
  // Ticked member units, seeded from ALL of motive.combination.members —
  // which includes the motive unit, so it shows ticked — and narrowed only
  // by unticking. The motive unit cannot be unticked — it is the
  // inspection's subject and carries the odometer (FR-INS-064).
  attachedIds: string[];
  onToggleAttached: (vehicleId: string) => void;
  onStart: (init: {
    odometerKm: number | null;
    observedMemberVehicleIds: string[];
    warnings: RecordedWarning[];
  }) => void;
}) {
  const [odometer, setOdometer] = useState<string>(
    motive.lastOdometerKm === null ? "" : String(motive.lastOdometerKm),
  );
  const [touched, setTouched] = useState(false);
  // FR-INS-033 says warn and REQUIRE confirmation. Defaulting the box to
  // checked satisfies the control without the driver ever acting on it,
  // which is the same as not having the control.
  const [confirmed, setConfirmed] = useState(false);
  // Frozen at mount. This screen is open for seconds and nothing on it is
  // time-sensitive at a finer grain than a day, so reading the clock during
  // render would only make the output depend on when React happened to
  // re-render — FR-INS-033's own denominator included.
  const [openedAt] = useState(() => Date.now());

  const value = odometer === "" ? null : parseInt(odometer, 10);
  const rejection = odometerRejection(value, motive);
  const warnings = odometerWarnings(value, motive, new Date(openedAt));
  // FR-INS-020: optional, and a trailer-only inspection has no field at all.
  // Gate on what the unit IS, not on whether it happens to have a reading —
  // no vehicle has one until the first inspection writes it, so gating on
  // history means the timeline can never be started and FR-INS-032/033
  // never acquire a denominator.
  const wantsOdometer = motive.unitKind !== "TRAILER";
  const held = warnings.length > 0 && !confirmed;

  function start() {
    if (rejection) return;
    if (held) return;
    onStart({
      odometerKm: wantsOdometer ? value : null,
      // attachedIds already contains the motive unit — it is a member of
      // its own combination and renders ticked-and-disabled. Prepending it
      // again would send a duplicate straight into the FR-INS-063
      // warning's entered_value.
      observedMemberVehicleIds: attachedIds,
      // FR-INS-033's confirmation governs the capture flow; DR-020 governs
      // the timeline. A confirmed implausible value still submits with the
      // inspection and is preserved on the warning record rather than written
      // to an append-only timeline that would keep it forever (DR-018).
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

      {/* FR-INS-062: the driver CONFIRMS the rig, they do not compose it.
          What is coupled to what is fleet configuration a CONTROLLER sets
          before the trip (ManageAssignments); the driver's job here is to
          say whether that is what is actually in front of them. Pre-ticked
          from the served composition, which is the requirement's
          "defaulting to the last recorded composition".

          Unticking is FR-INS-063's observation, not an edit: it travels as
          observed_member_vehicle_ids and the server records the difference
          for a controller to reconcile. Nothing here writes fleet state. */}
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
            Something else coupled up? Finish this inspection and tell the office — they set the
            rig.
          </p>
        </fieldset>
      )}

      {wantsOdometer && (
        <fieldset className="cap-card">
          <legend className="cap-eyebrow">Odometer</legend>
          <p className={`cap-odo${odometer === "" ? " is-empty" : ""}`} aria-live="polite">
            {odometer === "" ? "000 000" : grouped(odometer)}
            <span className="cap-odo-unit">km</span>
          </p>
          <p className="cap-hint">
            {motive.lastOdometerKm === null
              ? "No reading on record yet — this one starts the count."
              : `Last reading ${motive.lastOdometerKm.toLocaleString("en-ZA")} km`}
            {motive.lastOdometerAt
              ? `, ${Math.round((openedAt - Date.parse(motive.lastOdometerAt)) / 86_400_000)} days ago`
              : ""}
          </p>
          <Keypad
            granularityMm={ODOMETER_GRANULARITY_KM}
            goLabel="Done ›"
            goTone="default"
            onKey={(k) => {
              if (k.type === "digit") {
                // The first digit REPLACES the prefill. Appending to a
                // prefilled 412180 gives 4121801, which is both wrong and
                // the kind of wrong a driver will not notice.
                setOdometer((o) =>
                  touched ? (o.length >= ODOMETER_MAX_DIGITS ? o : o + k.digit) : k.digit,
                );
                setTouched(true);
              }
              if (k.type === "delete") setOdometer("");
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
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>
                <span className="cap-confirm-msg">{w.message}</span>
                <span className="cap-hint">Tick to confirm the reading is right.</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      {/* NFR-PRV-006. Most drivers are on their own phone, and this sentence
          has to be true — the storage tests in draft.test.ts keep it true. */}
      <p className="cap-notice">
        While you are working, this inspection is saved on your phone. Nothing else about the fleet
        is stored here.
      </p>

      <button
        type="button"
        className="cap-primary"
        onClick={start}
        disabled={rejection !== null || held}
      >
        Start inspection
      </button>
    </section>
  );
}
