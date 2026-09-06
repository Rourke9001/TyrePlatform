import { useState } from "react";

import "./capture.css";

// The one confirmation in the capture app. It exists for two recovery paths
// — a wrong-vehicle Start (TYRE-146) and a refused outbox entry the office
// has taken over the phone (TYRE-167) — and for nothing on the clean path:
// web/CLAUDE.md forbids confirmation steps there, and this component renders
// a single secondary button until it is pressed. Inline, not a modal, for
// the same reason: nothing here may trap focus or block the sheet behind it.
//
// FR-OFF-014 forbids a SILENT discard. What makes this one not silent is the
// text the caller supplies: which vehicle, and what is lost (ADR-0009).
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
