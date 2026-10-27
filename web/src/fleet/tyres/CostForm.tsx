import { type FormEvent, useId, useState } from "react";

import { COST_SOURCES, setTyreCost, type CostSource, type Tyre } from "../../api/tyres";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import { TextInput } from "../../ui/TextInput";
import { RefusalAlert } from "../RefusalAlert";
import { tyresKey } from "../unit/queryKeys";
import { useFormMutation } from "../useFormMutation";

// Its own wording, not DisposeForm's: see DisposeForm.tsx's comment on why a
// shared sentence between the two forms is wrong here.
const COST_WORDING = {
  speakable: ["TY013"],
  forbidden: "You do not have permission to record a tyre's cost.",
  fallback: "The cost could not be recorded. Try again, or call support if it keeps happening.",
};

// FR-TYR-041's costing step, discharging CFL-002's backlog. Rendered only
// where awaitingCost is true; D5/TY013: an already-costed row must never
// offer a second submission, not even disabled. Every re-cost/negative-price
// rule is app.set_tyre_cost's (ADR-0013 decision 5). The confirmation lives
// at the register (ActedOn, TyreList.tsx, NFR-USE-010).
export function CostForm({
  tyre,
  tenantKey,
  onSuccess,
}: {
  tyre: Tyre;
  tenantKey: string;
  onSuccess?: () => void;
}) {
  const [price, setPrice] = useState("");
  // FR-TYR-002 has three provenance values and NFR-PRO-002 makes absence never
  // a default; app.set_tyre_cost refuses a correction once a price exists
  // (000031), so a pre-selected INVOICE would stick.
  const [costSource, setCostSource] = useState<CostSource | "">("");
  const hintId = useId();
  const sourceMissing = price.trim() !== "" && costSource === "";

  const cost = useFormMutation({
    // Price stays a string end to end (rule 2), never Number()'d, here or
    // in setTyreCost itself.
    mutate: (vars: { price: string; source: CostSource }) => setTyreCost(tyre.id, vars),
    invalidate: [tyresKey(tenantKey)],
    onSuccess: () => {
      setPrice("");
      setCostSource("");
      onSuccess?.();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (price.trim() === "" || costSource === "") return;
    cost.submit({ price, source: costSource });
  }

  return (
    <form onSubmit={submit} className="fleet-row-form">
      <TextInput
        aria-label={`Purchase price for ${tyre.displayCode}`}
        mono
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        inputMode="decimal"
        required
      />

      <Select
        aria-label={`Cost source for ${tyre.displayCode}`}
        value={costSource}
        onChange={(e) =>
          setCostSource(COST_SOURCES.find((c) => c.value === e.target.value)?.value ?? "")
        }
        required
        aria-describedby={sourceMissing ? hintId : undefined}
        options={[{ value: "", label: "Choose a source" }, ...COST_SOURCES]}
      />
      {sourceMissing && (
        <p className="fleet-hint" id={hintId}>
          Choose where this price came from. A cost cannot be corrected once it is recorded.
        </p>
      )}

      <Button type="submit" disabled={price.trim() === "" || costSource === "" || cost.isPending}>
        {cost.isPending ? "Saving…" : "Set cost"}
      </Button>

      <RefusalAlert error={cost.error} wording={COST_WORDING} />
    </form>
  );
}
