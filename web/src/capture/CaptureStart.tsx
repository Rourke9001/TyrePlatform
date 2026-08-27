import { useState } from "react";

import type { CaptureContext } from "./captureContext";
import { odometerRejection, odometerWarnings, projectedOdometerKm } from "./history";
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
  storageBlocked,
  attachedIds,
  onToggleAttached,
  onStart,
}: {
  // The unit the driver navigated to. FR-INS-064: only the motive unit's
  // odometer is recorded, and distance is never apportioned to a towed one.
  motive: CaptureContext;
  // The device will not let the app write, so there is nowhere to put an
  // inspection. CaptureFlow carries the reason and the retry above this
  // screen; all this control has to do is stop looking live, because a button
  // that silently does nothing is a worse answer than a refusal (NFR-USE-005).
  storageBlocked: boolean;
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
  // What the driver typed. Empty means they typed nothing, which is not the
  // same as an empty field: the screen may still be showing a projection.
  const [typed, setTyped] = useState("");
  // FR-INS-020 records CONFIRMED values only, so an untouched projection is
  // absent rather than recorded. This flag is the confirmation, and nothing
  // sets it but the driver's own tap — a default of true would record a
  // number nobody read, which is the fabrication NFR-PRO-003 refuses and the
  // one thing the pre-fill must not be able to do.
  const [accepted, setAccepted] = useState(false);
  // FR-INS-033 says warn and REQUIRE confirmation. Defaulting the box to
  // checked satisfies the control without the driver ever acting on it,
  // which is the same as not having the control. Separate from `accepted`
  // above: one confirms WHAT the reading is, the other confirms that an
  // implausible jump is real.
  const [plausible, setPlausible] = useState(false);
  // Frozen at mount. This screen is open for seconds and nothing on it is
  // time-sensitive at a finer grain than a day, so reading the clock during
  // render would only make the output depend on when React happened to
  // re-render — FR-INS-033's own denominator included.
  const [openedAt] = useState(() => Date.now());

  // FR-INS-020's three clauses, in one expression. A typed number is the
  // driver correcting the projection; a tapped confirmation is the driver
  // accepting it; anything else is an odometer this inspection does not
  // carry. Every check below reads this rather than what is on screen, so an
  // unconfirmed projection can gate nothing and block nothing — which is what
  // keeps "pre-filled" and "shall never block a tyre inspection" true at the
  // same time.
  const projected = projectedOdometerKm(motive, new Date(openedAt));
  const value = typed !== "" ? parseInt(typed, 10) : accepted ? projected : null;
  const rejection = odometerRejection(value, motive);
  const warnings = odometerWarnings(value, motive, new Date(openedAt));
  // What the readout shows: the driver's digits, else the projection offered
  // for confirmation, else nothing. Dimmed until it is the recorded value, so
  // a provisional number never looks like an entered one (NFR-USE-005).
  const shown = typed !== "" ? typed : projected !== null ? String(projected) : "";
  // FR-INS-020: optional, and a trailer-only inspection has no field at all.
  // Gate on what the unit IS, not on whether it happens to have a reading —
  // no vehicle has one until the first inspection writes it, so gating on
  // history means the timeline can never be started and FR-INS-032/033
  // never acquire a denominator.
  const wantsOdometer = motive.unitKind !== "TRAILER";
  const held = warnings.length > 0 && !plausible;

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
          <p className={`cap-odo${value === null ? " is-empty" : ""}`} aria-live="polite">
            {shown === "" ? "000 000" : grouped(shown)}
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
          {/* The confirm half of "confirm or correct". One tap against six
              digits is the trade FR-INS-020 is making, so the control is the
              cheap path and typing is the fallback — and the label carries the
              number, because a driver who taps a button reading only "That's
              right" has agreed to something they were not made to read. It
              disappears once the value is the driver's, which is also how the
              screen says the number counts. */}
          {value === null && projected !== null && (
            <button type="button" className="cap-secondary" onClick={() => setAccepted(true)}>
              Confirm {grouped(String(projected))} km
            </button>
          )}
          {value === null && projected !== null && (
            <p className="cap-hint">
              Worked out from that reading and this unit&rsquo;s usual daily distance. Check it
              against the dash — confirm it, type the real number, or skip it.
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

      {/* NFR-PRV-006, erratum CS-2. Most drivers are on their own phone, and
          this sentence has to be true — the storage tests in draft.test.ts keep
          the inspection half true, and the device id it names is the one in
          payload.ts (NFR-OBS-004). */}
      <p className="cap-notice">
        While you are working, this inspection is saved on your phone, along with a random code that
        identifies the phone to the platform — not you. Nothing else about the fleet is stored here.
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
