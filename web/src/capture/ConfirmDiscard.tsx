import { useState } from "react";

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
      <button
        type="button"
        className="cap-secondary cap-discard-trigger"
        onClick={() => setOpen(true)}
      >
        {trigger}
      </button>
    );
  }
  return (
    <section role="group" aria-label={question} className="cap-discard">
      <p className="cap-discard-q">{question}</p>
      <p className="cap-discard-cost">{consequence}</p>
      <div className="cap-discard-actions">
        {/* Keep first and primary: the safe answer is the easy one to hit
            with a glove (NFR-USE-004). */}
        <button type="button" className="cap-primary" onClick={() => setOpen(false)}>
          Keep it
        </button>
        <button type="button" className="cap-secondary cap-discard-confirm" onClick={onConfirm}>
          {confirm}
        </button>
      </div>
    </section>
  );
}
