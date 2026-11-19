import { useEffect, useRef, useState } from "react";

import { stampSubject } from "../api/token";
import { ConfirmDiscard } from "./ConfirmDiscard";
import type { Draft } from "./draft";
import { clearDraft, loadDraft } from "./draft";
import { draftLostWords } from "./lostWords";
import { mayCarry } from "./outbox";
import { inspectionEnded, writeFailed } from "./storageFaults";

// TYRE-333: a draft that breaks the page locks the phone, since one draft
// per phone means no other inspection can start (FR-OFF-014). It offers
// only a draft this driver may carry (U104), and deletes the draft row only:
// the outbox is never read or written.
export function ErrorDiscard({ onDiscarded }: { onDiscarded: () => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [failed, setFailed] = useState(false);
  // A navigation unmounts this while a read or a delete is in flight; the
  // delete still lands, so only the screen's own follow-up is dropped.
  const dropped = useRef(false);

  useEffect(() => {
    dropped.current = false;
    void loadDraft().then(
      (existing) => {
        if (dropped.current) return;
        if (existing && mayCarry(existing, stampSubject())) setDraft(existing);
      },
      () => undefined,
    );
    return () => {
      dropped.current = true;
    };
  }, []);

  if (draft === null) return null;

  function discard() {
    void clearDraft().then(
      () => {
        inspectionEnded();
        if (!dropped.current) onDiscarded();
      },
      () => {
        writeFailed();
        if (!dropped.current) setFailed(true);
      },
    );
  }

  return (
    <>
      <ConfirmDiscard
        trigger="Discard this inspection"
        question={`Discard the inspection of ${draft.fleetNumber ?? "this vehicle"}?`}
        consequence={draftLostWords(draft)}
        confirm="Discard"
        onConfirm={discard}
      />
      {failed && <p>Could not discard it. This phone is not saving reliably.</p>}
    </>
  );
}
