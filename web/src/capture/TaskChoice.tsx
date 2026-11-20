import { useTenantInstant } from "../time/tenantTime";
import { Button } from "../ui/Button";
import { BackToWork } from "./CaptureDone";
import { ConfirmDiscard } from "./ConfirmDiscard";
import type { Draft } from "./draft";
import { draftLostWords } from "./lostWords";
import "./capture.css";

// TYRE-323 (U147 B7): the task the driver opened differs from the one the
// held inspection was started for. One screen, no modal, and nothing is
// written until a tap (FR-OFF-014).
export function TaskChoice({
  draft,
  onCarryOn,
  onStartAgain,
}: {
  draft: Draft;
  onCarryOn: () => void;
  onStartAgain: () => void;
}) {
  const tenantInstant = useTenantInstant();
  const fleet = draft.fleetNumber ?? "this vehicle";
  return (
    <section className="cap-screen">
      <p role="alert" className="cap-alert cap-alert--caution">
        You have an inspection of {fleet} in progress on this phone, started{" "}
        {tenantInstant(draft.startedAt)}. The task you opened is a different one.
      </p>
      <Button variant="primary" size="glove" block onClick={onCarryOn}>
        Carry on for this task
      </Button>
      <ConfirmDiscard
        trigger="Start again"
        question={`Discard the inspection of ${fleet}?`}
        consequence={draftLostWords(draft)}
        confirm="Discard"
        onConfirm={onStartAgain}
      />
      <BackToWork />
    </section>
  );
}
