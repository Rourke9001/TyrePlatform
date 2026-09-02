import { type FormEvent, useState } from "react";

import { refusalMessage } from "../../api/refusal";
import { DISPOSALS, disposeTyre, type Disposal, type Tyre } from "../../api/tyres";
import { useFormMutation } from "../useFormMutation";

// DisposeForm and CostForm refuse for different reasons and must say so:
// app.dispose_tyre raises TY012 and app.set_tyre_cost raises TY013, and
// neither can raise the other's. One shared sentence for both is how the
// cost form came to tell an operator their tyre "could not be disposed of".
const DISPOSE_WORDING = {
  speakable: ["TY012"],
  forbidden: "You do not have permission to dispose of a tyre.",
  fallback: "The tyre could not be disposed of. Try again, or call support if it keeps happening.",
};

// Every rule about which transitions are legal, and about reason/proceeds,
// is app.dispose_tyre's alone (ADR-0013 decision 5) — this only shapes the
// request and shows the field the chosen disposal actually needs.
export function DisposeForm({ tyre, tenantKey }: { tyre: Tyre; tenantKey: string }) {
  const [disposal, setDisposal] = useState<Disposal | "">("");
  const [reason, setReason] = useState("");
  const [proceeds, setProceeds] = useState("");

  const dispose = useFormMutation({
    mutate: (vars: { disposal: Disposal; reason?: string; proceeds?: string }) =>
      disposeTyre(tyre.id, vars),
    invalidate: [["tyres", tenantKey]],
    onSuccess: () => {
      setDisposal("");
      setReason("");
      setProceeds("");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (disposal === "") return;
    dispose.submit({
      disposal,
      reason: disposal === "SCRAPPED" ? reason : undefined,
      proceeds: disposal === "SOLD" ? proceeds : undefined,
    });
  }

  return (
    <form onSubmit={submit} className="tyres-row-form">
      <select
        aria-label={`Disposal for ${tyre.displayCode}`}
        value={disposal}
        onChange={(e) => setDisposal(e.target.value as Disposal | "")}
      >
        <option value="">Choose…</option>
        {DISPOSALS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>

      {disposal === "SCRAPPED" && (
        <input
          aria-label={`Reason for ${tyre.displayCode}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      )}

      {disposal === "SOLD" && (
        <input
          aria-label={`Proceeds for ${tyre.displayCode}`}
          value={proceeds}
          onChange={(e) => setProceeds(e.target.value)}
          inputMode="decimal"
          required
        />
      )}

      <button
        className="btn-primary btn-compact"
        type="submit"
        disabled={disposal === "" || dispose.isPending}
      >
        {dispose.isPending ? "Disposing…" : "Dispose"}
      </button>

      {dispose.error !== null && (
        <p role="alert">{refusalMessage(dispose.error, DISPOSE_WORDING)}</p>
      )}
    </form>
  );
}
