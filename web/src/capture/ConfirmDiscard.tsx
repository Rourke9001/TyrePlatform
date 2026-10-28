import { useState } from "react";

import { Button } from "../ui/Button";
import "./capture.css";

// The one confirmation in the capture app: a wrong-vehicle Start (TYRE-146)
// and a refused outbox entry the office has taken over the phone
// (TYRE-167). Nothing on the clean path (web/CLAUDE.md bans confirmation
// steps there). Inline, not a modal, so nothing traps focus. FR-OFF-014
// forbids a SILENT discard; the caller-supplied text (which vehicle, what
// is lost, ADR-0009) is what makes this one not silent.
export function ConfirmDiscard({
  trigger,
  question,
  consequence,
  confirm,
  onConfirm,
}: {
  trigger: string;
  question: string;
  consequence: string;
  confirm: string;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button variant="secondary" size="glove" block onClick={() => setOpen(true)}>
        {trigger}
      </Button>
    );
  }
  return (
    <section role="group" aria-label={question} className="cap-discard">
      <p className="cap-discard-q">{question}</p>
      <p className="cap-discard-cost">{consequence}</p>
      <div className="cap-discard-actions">
        {/* Keep first and primary: the safe answer is the easy one to hit
            with a glove (NFR-USE-004). */}
        <Button variant="primary" size="glove" onClick={() => setOpen(false)}>
          Keep it
        </Button>
        <Button variant="secondary" size="glove" onClick={onConfirm}>
          {confirm}
        </Button>
      </div>
    </section>
  );
}
