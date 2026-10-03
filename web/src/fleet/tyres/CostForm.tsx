import { type FormEvent, useState } from "react";

import { COST_SOURCES, setTyreCost, type CostSource, type Tyre } from "../../api/tyres";
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
  const [costSource, setCostSource] = useState<CostSource>("INVOICE");

  const cost = useFormMutation({
    // Price stays a string end to end (rule 2), never Number()'d, here or
    // in setTyreCost itself.
    mutate: (vars: { price: string; source: CostSource }) => setTyreCost(tyre.id, vars),
    invalidate: [tyresKey(tenantKey)],
    onSuccess: () => {
      setPrice("");
      setCostSource("INVOICE");
      onSuccess?.();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (price.trim() === "") return;
    cost.submit({ price, source: costSource });
  }

  return (
    <form onSubmit={submit} className="tyres-row-form">
      <input
        aria-label={`Purchase price for ${tyre.displayCode}`}
        value={price}
        onChange={(e) => setPrice(e.target.value)}
        inputMode="decimal"
        required
      />

      <select
        aria-label={`Cost source for ${tyre.displayCode}`}
        value={costSource}
        onChange={(e) => setCostSource(e.target.value as CostSource)}
      >
        {COST_SOURCES.map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </select>

      <button
        className="btn-primary btn-compact"
        type="submit"
        disabled={price.trim() === "" || cost.isPending}
      >
        {cost.isPending ? "Saving…" : "Set cost"}
      </button>

      <RefusalAlert error={cost.error} wording={COST_WORDING} />
    </form>
  );
}
