import { type FormEvent, useState } from "react";

import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import { setUnitStatus, type Unit } from "../../api/units";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Field } from "../../ui/Field";
import { Select } from "../../ui/Select";
import { TextInput } from "../../ui/TextInput";
import { useFormMutation } from "../useFormMutation";
import { unitKey, vehiclesKey } from "./queryKeys";
import { UNIT_STATUSES } from "./vocabulary";

// TY016 names the unit and counts its open fitments; that sentence is the
// whole value of the refusal, spoken verbatim (NFR-USE-005, ADR-0012).
const STATUS_WORDING = {
  speakable: ["TY012", "TY016"],
  forbidden: "You do not have permission to change this unit's status.",
  fallback: "The status could not be changed. Try again, or call support if it keeps happening.",
};

// FR-VEH-005/006: which transitions are legal is app.set_vehicle_status'
// rule, so this offers all six and lets the refusal explain (ADR-0013
// decision 5).
export function UnitStatusForm({ unit }: { unit: Unit }) {
  const tenantKey = getDevTenantId() ?? "default";
  const [status, setStatus] = useState(unit.status);
  const [reason, setReason] = useState("");

  const change = useFormMutation({
    mutate: (vars: { status: string; reason?: string }) => setUnitStatus(unit.id, vars),
    invalidate: [unitKey(unit.id), vehiclesKey(tenantKey)],
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
    <Card title="Status" padding="md">
      <form className="unit-form unit-form--row" onSubmit={submit}>
        <Field label="Status">
          <Select
            id={`unit-status-${unit.id}`}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            options={UNIT_STATUSES}
          />
        </Field>

        {status === "DISPOSED" && (
          <Field label="Reason">
            <TextInput
              id={`unit-status-reason-${unit.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </Field>
        )}

        <Button variant="primary" type="submit" disabled={change.isPending}>
          {change.isPending ? "Setting…" : "Set status"}
        </Button>
      </form>

      {change.isSuccess && <p role="status">The status was changed.</p>}
      {change.error !== null && <p role="alert">{refusalMessage(change.error, STATUS_WORDING)}</p>}
    </Card>
  );
}
