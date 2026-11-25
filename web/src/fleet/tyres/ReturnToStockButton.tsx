import { type FormEvent, useState } from "react";

import { returnTyreToStock, type Tyre } from "../../api/tyres";
import { useTenantToday } from "../../time/tenantTime";
import { Button } from "../../ui/Button";
import { OccurredOnFields } from "../OccurredOnFields";
import { askWhy, occurredOnBody, WHY_REQUIRED } from "../occurredOn";
import { RefusalAlert } from "../RefusalAlert";
import { tyresKey } from "../unit/queryKeys";
import { useFormMutation } from "../useFormMutation";

// This control never sends a depotId, so TY014 comes only from the day
// rule: a later day, or an earlier one with no reason (000067).
const RETURN_WORDING = {
  speakable: ["TY012", "TY014"],
  forbidden: "You do not have permission to return a tyre to stock.",
  fallback:
    "The tyre could not be returned to stock. Try again, or call support if it keeps happening.",
};

// FR-FIT-013: the casing comes back, no depot picker this slice (D2); the
// tyre keeps its current_depot_id, so this says the fleet has it back, not
// that it moved. Confirmation lives at the register (ActedOn, TyreList.tsx,
// NFR-USE-010). Today stays one click: the day is empty unless filled.
export function ReturnToStockButton({
  tyre,
  tenantKey,
  onSuccess,
}: {
  tyre: Tyre;
  tenantKey: string;
  onSuccess?: () => void;
}) {
  const [day, setDay] = useState("");
  const [why, setWhy] = useState("");
  const [refused, setRefused] = useState("");
  const today = useTenantToday();

  const ret = useFormMutation({
    mutate: (body: { occurredOn?: string; backdateReason?: string }) =>
      returnTyreToStock(tyre.id, body),
    invalidate: [tyresKey(tenantKey)],
    onSuccess: () => {
      setDay("");
      setWhy("");
      onSuccess?.();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const occurred = occurredOnBody(day, why, today);
    if (occurred === null) {
      setRefused(WHY_REQUIRED);
      return;
    }
    setRefused("");
    const body: { occurredOn?: string; backdateReason?: string } = {};
    if (occurred.occurredOn !== undefined) body.occurredOn = occurred.occurredOn;
    if (occurred.why !== undefined) body.backdateReason = occurred.why;
    ret.submit(body);
  }

  return (
    <form onSubmit={submit}>
      <OccurredOnFields
        idPrefix={`return-${tyre.id}`}
        day={day}
        onDay={setDay}
        why={why}
        onWhy={setWhy}
        today={today}
        ask={askWhy(day, today, ret.error)}
      />
      <Button type="submit" disabled={ret.isPending}>
        {ret.isPending ? "Returning…" : "Return to stock"}
      </Button>

      <RefusalAlert message={refused} />
      <RefusalAlert error={ret.error} wording={RETURN_WORDING} />
    </form>
  );
}
