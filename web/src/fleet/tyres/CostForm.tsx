import { type FormEvent, useState } from "react";

import { refusalMessage } from "../../api/refusal";
import { COST_SOURCES, setTyreCost, type CostSource, type Tyre } from "../../api/tyres";
import { useFormMutation } from "../useFormMutation";

// Its own wording, not DisposeForm's: see DisposeForm.tsx's comment on why a
// shared sentence between the two forms is wrong here.
const COST_WORDING = {
  speakable: ["TY013"],
  forbidden: "You do not have permission to record a tyre's cost.",
  fallback: "The cost could not be recorded. Try again, or call support if it keeps happening.",
};

// FR-TYR-041's costing step, the discharge for the awaiting-cost backlog
// CFL-002 names. Rendered only on a row where awaitingCost is true (the
// caller's job, not this component's): D5's own TY013 rationale — "a
// correction later is a decision this surface does not take" — means an
// already-costed row must never offer a second submission, not even a
// disabled one. Every rule about a re-costed or negative price is
// app.set_tyre_cost's alone (ADR-0013 decision 5).
//
// onSuccess names nothing further: costing a tyre clears its awaiting-cost
// flag and the cell holding this form becomes a dash on the refetch, so the
// confirmation lives at the register (ActedOn in TyreList.tsx, NFR-USE-010).
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
    // Price stays a string end to end (rule 2) — never Number()'d, here or
    // in setTyreCost itself.
    mutate: (vars: { price: string; source: CostSource }) => setTyreCost(tyre.id, vars),
    invalidate: [["tyres", tenantKey]],
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

      {cost.error !== null && <p role="alert">{refusalMessage(cost.error, COST_WORDING)}</p>}
    </form>
  );
}
