import { type FormEvent, useState } from "react";

import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import { rotateTyres, type RotationMove, type Unit } from "../../api/units";
import { useFormMutation } from "../useFormMutation";
import { ODOMETER_REFUSAL, readOdometer } from "./odometer";
import { openFitmentsKey, unitFitmentsKey, unitKey } from "./queryKeys";

// app.rotate_tyres refuses the whole set or none of it, and the codes it can
// reach are TY009, TY012 and TY014 — no occupancy code, because a rotation's
// targets are freed inside the same statement. TY009 arrives from the fitment
// rows this write inserts (FR-FIT-002, 000025's
// fitment_odometer_matches_unit_kind), which is why the odometer below is
// asked for rather than offered.
const ROTATE_WORDING = {
  speakable: ["TY009", "TY012", "TY014"],
  forbidden: "You do not have permission to rotate tyres.",
  fallback: "The rotation could not be applied. Try again, or call support if it keeps happening.",
};

const TOO_FEW =
  "Pick at least two positions: a rotation moves tyres between positions of this unit.";
const INCOMPLETE = "Every picked position needs a target and a tread reading.";

// FR-FIT-010: one set of moves within one unit, applied whole or not at all.
// The odometer is asked once because the unit has one reading at the moment
// of the rotation, and a tread is asked per tyre because each is measured
// where it comes off (NFR-USE-006 — never ask for the same value twice).
export function RotateForm({ unit }: { unit: Unit }) {
  const tenantKey = getDevTenantId() ?? "default";
  const occupied = unit.positions.filter((p) => p.fitment !== null);

  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [treads, setTreads] = useState<Record<string, string>>({});
  const [odometer, setOdometer] = useState("");
  const [refused, setRefused] = useState("");

  const rotate = useFormMutation({
    mutate: (vars: { moves: RotationMove[]; odometer?: number }) => rotateTyres(unit.id, vars),
    invalidate: [unitKey(unit.id), unitFitmentsKey(unit.id), openFitmentsKey(tenantKey)],
    onSuccess: () => {
      setPicked({});
      setTargets({});
      setTreads({});
      setOdometer("");
    },
  });

  const chosen = occupied.filter((p) => picked[p.id]);

  function submit(e: FormEvent) {
    e.preventDefault();
    // D7 makes this form the two-or-more case. One position moving is a
    // removal and a fit, which the position panel already does and which
    // records a different pair of events.
    if (chosen.length < 2) {
      setRefused(TOO_FEW);
      return;
    }
    const moves: RotationMove[] = [];
    for (const position of chosen) {
      const target = targets[position.id] ?? "";
      const tread = (treads[position.id] ?? "").trim();
      if (target === "" || tread === "" || position.fitment === null) {
        setRefused(INCOMPLETE);
        return;
      }
      moves.push({ tyreId: position.fitment.tyreId, toPositionId: target, treadMm: tread });
    }
    const reading = readOdometer(unit.hasOdometer ? odometer : "");
    if (!reading.ok) {
      setRefused(ODOMETER_REFUSAL);
      return;
    }
    setRefused("");
    rotate.submit({ moves, odometer: reading.value });
  }

  if (occupied.length === 0) {
    return (
      <section className="unit-rotate" aria-labelledby="rotate-heading">
        <h2 id="rotate-heading">Rotate</h2>
        <p>This unit carries no tyres to rotate.</p>
      </section>
    );
  }

  return (
    <section className="unit-rotate" aria-labelledby="rotate-heading">
      <h2 id="rotate-heading">Rotate</h2>
      <form onSubmit={submit}>
        <ul className="unit-rotate-rows">
          {occupied.map((p) => (
            <li key={p.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={`Rotate ${p.code}`}
                  checked={picked[p.id] ?? false}
                  onChange={(e) => setPicked({ ...picked, [p.id]: e.target.checked })}
                />
                {p.code}
              </label>

              {picked[p.id] && (
                <>
                  <select
                    aria-label={`Target for ${p.code}`}
                    value={targets[p.id] ?? ""}
                    onChange={(e) => setTargets({ ...targets, [p.id]: e.target.value })}
                  >
                    <option value="">Choose…</option>
                    {unit.positions.map((target) => (
                      <option key={target.id} value={target.id}>
                        {target.code}
                      </option>
                    ))}
                  </select>
                  <input
                    aria-label={`Tread for ${p.code}`}
                    inputMode="decimal"
                    value={treads[p.id] ?? ""}
                    onChange={(e) => setTreads({ ...treads, [p.id]: e.target.value })}
                  />
                </>
              )}
            </li>
          ))}
        </ul>

        {unit.hasOdometer && (
          <label className="unit-rotate-odometer">
            Odometer
            <input
              inputMode="numeric"
              value={odometer}
              onChange={(e) => setOdometer(e.target.value)}
              required
            />
          </label>
        )}

        <button className="btn-primary" type="submit" disabled={rotate.isPending}>
          {rotate.isPending ? "Rotating…" : "Rotate"}
        </button>
      </form>

      {/* useFormMutation keeps isSuccess for the life of the form, so a guard
          that stops the next attempt would otherwise leave "The rotation was
          applied" standing beside the sentence saying nothing was sent. */}
      {rotate.isSuccess && refused === "" && <p role="status">The rotation was applied.</p>}
      {refused !== "" && <p role="alert">{refused}</p>}
      {rotate.error !== null && <p role="alert">{refusalMessage(rotate.error, ROTATE_WORDING)}</p>}
    </section>
  );
}
