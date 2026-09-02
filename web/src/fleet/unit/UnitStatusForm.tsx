import { type FormEvent, useState } from "react";

import { refusalMessage } from "../../api/refusal";
import { setUnitStatus, type Unit } from "../../api/units";
import { useFormMutation } from "../useFormMutation";
import { unitKey } from "./queryKeys";
import { UNIT_STATUSES } from "./vocabulary";

// TY016 is the disposal of a unit that still carries tyres, and it names the
// unit and counts them. That sentence is the whole value of the refusal, so
// it is spoken verbatim rather than replaced by a general one (NFR-USE-005,
// ADR-0012).
const STATUS_WORDING = {
  speakable: ["TY012", "TY016"],
  forbidden: "You do not have permission to change this unit's status.",
  fallback: "The status could not be changed. Try again, or call support if it keeps happening.",
};

// FR-VEH-005/006. Which transitions are legal — DISPOSED is terminal, a
// disposal needs an empty unit and a stated reason — is
// app.set_vehicle_status' rule, so this offers all six and lets the refusal
// explain (ADR-0013 decision 5).
export function UnitStatusForm({ unit }: { unit: Unit }) {
  const [status, setStatus] = useState(unit.status);
  const [reason, setReason] = useState("");

  const change = useFormMutation({
    mutate: (vars: { status: string; reason?: string }) => setUnitStatus(unit.id, vars),
    invalidate: [unitKey(unit.id)],
    onSuccess: () => {
      setReason("");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    change.submit({
      status,
      reason: status === "DISPOSED" ? reason : undefined,
    });
  }

  return (
    <section className="unit-status" aria-labelledby="unit-status-heading">
      <h2 id="unit-status-heading">Status</h2>
      <form className="tyres-row-form" onSubmit={submit}>
        <label htmlFor={`unit-status-${unit.id}`}>Status</label>
        <select
          id={`unit-status-${unit.id}`}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {UNIT_STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>

        {status === "DISPOSED" && (
          <>
            <label htmlFor={`unit-status-reason-${unit.id}`}>Reason</label>
            <input
              id={`unit-status-reason-${unit.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </>
        )}

        <button className="btn-primary btn-compact" type="submit" disabled={change.isPending}>
          {change.isPending ? "Setting…" : "Set status"}
        </button>
      </form>

      {change.isSuccess && <p role="status">The status was changed.</p>}
      {change.error !== null && <p role="alert">{refusalMessage(change.error, STATUS_WORDING)}</p>}
    </section>
  );
}
