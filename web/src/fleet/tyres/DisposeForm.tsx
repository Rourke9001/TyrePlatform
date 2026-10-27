import { type FormEvent, useState } from "react";

import { disposalsFor, disposeTyre, type Disposal, type Tyre } from "../../api/tyres";
import { Button } from "../../ui/Button";
import { Select } from "../../ui/Select";
import { TextInput } from "../../ui/TextInput";
import { RefusalAlert } from "../RefusalAlert";
import { tyresKey } from "../unit/queryKeys";
import { useFormMutation } from "../useFormMutation";

// DisposeForm and CostForm refuse for different reasons (TY012 vs TY013)
// and must say so, or the cost form ends up telling an operator their tyre
// "could not be disposed of."
const DISPOSE_WORDING = {
  speakable: ["TY012"],
  forbidden: "You do not have permission to dispose of a tyre.",
  fallback: "The tyre could not be disposed of. Try again, or call support if it keeps happening.",
};

const BLANK_PROCEEDS = "Proceeds are required before a sale can be recorded.";

// Every legality/reason-proceeds rule is app.dispose_tyre's alone
// (ADR-0013 decision 5); disposalsFor (api/tyres.ts) already narrows the
// offered menu. The confirmation lives at the register (ActedOn,
// TyreList.tsx, NFR-USE-010).
export function DisposeForm({
  tyre,
  tenantKey,
  onSuccess,
}: {
  tyre: Tyre;
  tenantKey: string;
  onSuccess?: () => void;
}) {
  const [disposal, setDisposal] = useState<Disposal | "">("");
  const [reason, setReason] = useState("");
  const [proceeds, setProceeds] = useState("");
  // A refusal this form raised itself, distinct from the server's own
  // (rendered below from dispose.error). RetreadReturnRow's `refused`
  // pattern (RetreadQueue.tsx).
  const [refused, setRefused] = useState("");
  const offered = disposalsFor(tyre.state);

  const dispose = useFormMutation({
    mutate: (vars: { disposal: Disposal; reason?: string; proceeds?: string }) =>
      disposeTyre(tyre.id, vars),
    invalidate: [tyresKey(tenantKey)],
    onSuccess: () => {
      setDisposal("");
      setReason("");
      setProceeds("");
      onSuccess?.();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (disposal === "") return;
    // Omitted-optional-field pattern (omitIfBlank in RetreadQueue.tsx), but proceeds
    // is not optional on a sale, so this refuses locally rather than
    // omitting a key.
    if (disposal === "SOLD" && proceeds.trim() === "") {
      setRefused(BLANK_PROCEEDS);
      return;
    }
    setRefused("");
    dispose.submit({
      disposal,
      reason: disposal === "SCRAPPED" ? reason : undefined,
      proceeds: disposal === "SOLD" ? proceeds.trim() : undefined,
    });
  }

  return (
    <form onSubmit={submit} className="fleet-row-form">
      <Select
        aria-label={`Disposal for ${tyre.displayCode}`}
        value={disposal}
        onChange={(e) => setDisposal(e.target.value as Disposal | "")}
        options={[{ value: "", label: "Choose…" }, ...offered]}
      />

      {disposal === "SCRAPPED" && (
        <TextInput
          aria-label={`Reason for ${tyre.displayCode}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      )}

      {disposal === "SOLD" && (
        <TextInput
          aria-label={`Proceeds for ${tyre.displayCode}`}
          mono
          value={proceeds}
          onChange={(e) => setProceeds(e.target.value)}
          inputMode="decimal"
          required
        />
      )}

      <Button type="submit" disabled={disposal === "" || dispose.isPending}>
        {dispose.isPending ? "Disposing…" : "Dispose"}
      </Button>

      <RefusalAlert message={refused} />
      <RefusalAlert error={dispose.error} wording={DISPOSE_WORDING} />
    </form>
  );
}
