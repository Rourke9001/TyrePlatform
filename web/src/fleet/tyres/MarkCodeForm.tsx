import { type FormEvent, useState } from "react";

import { markReceiptCodes, markTyreCode, type ReceivedTyre, type Tyre } from "../../api/tyres";
import { Button } from "../../ui/Button";
import { TextInput } from "../../ui/TextInput";
import { RefusalAlert } from "../RefusalAlert";
import { tyresKey } from "../unit/queryKeys";
import { useFormMutation } from "../useFormMutation";

// app.mark_code_on_sidewall answers TY012 for every refusal (000062): a tyre
// not pending or gone from the fleet, a receipt with nothing to mark, and a
// day after today or before receipt.
const MARK_WORDING = {
  speakable: ["TY012"],
  forbidden: "You do not have permission to record a code as marked.",
  fallback: "The marking could not be recorded. Try again, or call support if it keeps happening.",
};

interface MarkVars {
  wholeReceipt: boolean;
  markedOn?: string;
}

// B22 (TYRE-99): records that a code the platform issued is on the
// sidewall, for this tyre or, when another loaded row waits on its receipt,
// for the whole receipt. A blank day is the server's today (rule 6). The
// confirmation lives at the register (ActedOn, TyreList.tsx, NFR-USE-010).
export function MarkCodeForm({
  tyre,
  tenantKey,
  wholeReceipt,
  onMarked,
}: {
  tyre: Tyre;
  tenantKey: string;
  wholeReceipt: boolean;
  onMarked: (marked: ReceivedTyre[]) => void;
}) {
  const [markedOn, setMarkedOn] = useState("");

  const mark = useFormMutation<MarkVars, ReceivedTyre[]>({
    mutate: (vars) => {
      const body = vars.markedOn === undefined ? {} : { markedOn: vars.markedOn };
      return vars.wholeReceipt && tyre.receiptId !== null
        ? markReceiptCodes(tyre.receiptId, body)
        : markTyreCode(tyre.id, body);
    },
    invalidate: [tyresKey(tenantKey)],
    onSuccess: (marked) => {
      setMarkedOn("");
      onMarked(marked);
    },
  });

  function send(whole: boolean) {
    mark.submit(markedOn === "" ? { wholeReceipt: whole } : { wholeReceipt: whole, markedOn });
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    send(false);
  }

  return (
    <form onSubmit={submit} className="fleet-row-form">
      <TextInput
        type="date"
        aria-label={`Marked on for ${tyre.displayCode}`}
        value={markedOn}
        onChange={(e) => setMarkedOn(e.target.value)}
      />
      <Button type="submit" disabled={mark.isPending}>
        Record as marked
      </Button>
      {wholeReceipt && (
        <Button disabled={mark.isPending} onClick={() => send(true)}>
          Record the whole receipt as marked
        </Button>
      )}
      <RefusalAlert error={mark.error} wording={MARK_WORDING} />
    </form>
  );
}
