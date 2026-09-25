import { type FormEvent, useRef, useState } from "react";

import { getDevTenantId } from "../../api/devTenant";
import { removeFitment, type Removal, type Unit, type UnitPosition } from "../../api/units";
import { RefusalAlert } from "../RefusalAlert";
import { useFormMutation } from "../useFormMutation";
import type { ActedSummary } from "./PositionPanel";
import { ODOMETER_REFUSAL, ODOMETER_REQUIRED, readOdometer } from "./odometer";
import { openFitmentsKey, tyresKey, unitFitmentsKey, unitKey } from "./queryKeys";
import { groupThousands } from "../../format/groupThousands";

const REMOVE_WORDING = {
  speakable: ["TY009", "TY012", "TY014"],
  forbidden: "You do not have permission to remove a tyre.",
  fallback: "The tyre could not be removed. Try again, or call support if it keeps happening.",
};

// CR-012 subtracts the fitted reading from this one to get the distance the
// tyre ran, and app.fitment's odometer_does_not_decrease (000001) refuses a
// smaller one as a 23514 the API can only report as a generic
// invalid_submission. Refusing here instead names the reading to beat.
function belowFittedOdometer(fitted: number): string {
  return `The odometer cannot be below ${groupThousands(String(fitted))}, the reading this tyre was fitted at.`;
}

// The occupied-position form. Rendered only while position.fitment is not
// null (D7); PositionPanel keys this component on the fitment id so a
// background refetch swapping the occupant remounts it fresh, since
// readings typed for the old fitment must never close a different one.
export function RemoveForm({
  unit,
  position,
  onActed,
  onRefused,
}: {
  unit: Unit;
  position: UnitPosition;
  onActed: (summary: ActedSummary) => void;
  onRefused: (message: string) => void;
}) {
  const tenantKey = getDevTenantId() ?? "default";

  const [reason, setReason] = useState("");
  const [removeTread, setRemoveTread] = useState("");
  const [removeOdometer, setRemoveOdometer] = useState("");
  // What the write named, read again in onSuccess rather than off the
  // fitment prop: a background refetch could have moved that prop on
  // before the response lands, and the sentence must name what this write
  // actually acted on.
  const submitted = useRef<{ code: string; fitmentId: string } | null>(null);

  const invalidate = [
    unitKey(unit.id),
    unitFitmentsKey(unit.id),
    tyresKey(tenantKey),
    openFitmentsKey(tenantKey),
  ];

  const remove = useFormMutation({
    mutate: (vars: { fitmentId: string; body: Removal }) =>
      removeFitment(vars.fitmentId, vars.body),
    invalidate,
    onSuccess: () => {
      if (submitted.current !== null) {
        onActed({ kind: "remove", ...submitted.current });
      }
      setReason("");
      setRemoveTread("");
      setRemoveOdometer("");
    },
  });

  function submitRemove(e: FormEvent) {
    e.preventDefault();
    const open = position.fitment;
    if (open === null || reason === "" || removeTread.trim() === "") return;
    if (unit.hasOdometer && removeOdometer.trim() === "") {
      onRefused(ODOMETER_REQUIRED);
      return;
    }
    const odometer = readOdometer(unit.hasOdometer ? removeOdometer : "");
    if (!odometer.ok) {
      onRefused(ODOMETER_REFUSAL);
      return;
    }
    if (
      odometer.value !== undefined &&
      open.fittedOdometer !== null &&
      odometer.value < open.fittedOdometer
    ) {
      onRefused(belowFittedOdometer(open.fittedOdometer));
      return;
    }
    onRefused("");
    submitted.current = { code: open.displayCode, fitmentId: open.fitmentId };
    remove.submit({
      fitmentId: open.fitmentId,
      body: { reason, treadMm: removeTread.trim(), odometer: odometer.value },
    });
  }

  return (
    <form className="unit-panel-form" onSubmit={submitRemove}>
      {/* FR-FIT-008: which reasons exist is tenant configuration, read off
          the unit rather than listed here (rule 5). */}
      <label htmlFor={`remove-reason-${position.id}`}>Reason</label>
      <select
        id={`remove-reason-${position.id}`}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      >
        <option value="">Choose…</option>
        {unit.removalReasons.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>

      <label htmlFor={`remove-tread-${position.id}`}>Tread (mm)</label>
      <input
        id={`remove-tread-${position.id}`}
        inputMode="decimal"
        value={removeTread}
        onChange={(e) => setRemoveTread(e.target.value)}
        required
      />

      {unit.hasOdometer && (
        <>
          <label htmlFor={`remove-odometer-${position.id}`}>Odometer</label>
          <input
            id={`remove-odometer-${position.id}`}
            inputMode="numeric"
            value={removeOdometer}
            onChange={(e) => setRemoveOdometer(e.target.value)}
            required
          />
        </>
      )}

      <button
        className="btn-primary btn-compact"
        type="submit"
        disabled={reason === "" || remove.isPending}
      >
        {remove.isPending ? "Removing…" : "Remove tyre"}
      </button>

      <RefusalAlert error={remove.error} wording={REMOVE_WORDING} />
    </form>
  );
}
