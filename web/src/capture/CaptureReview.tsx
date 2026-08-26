import { useMemo, useState } from "react";

import type { CaptureContext } from "./captureContext";
import type { Draft } from "./draft";
import { completenessByUnit, rigPositions } from "./rig";
import type { WarningCode } from "./warnings";
import "./capture.css";

// Short driver-facing names for what was flagged. The full sentence was shown
// at the position and acted on there (FR-INS-040); this list is the index back
// to it, not a second telling. A Record over the closed WarningCode union
// rather than a lookup with a fallback: adding a code without a name here is a
// compile error, which is the only thing that keeps the two from drifting.
// CR-010 / OR-LEG-001 governs every string in it.
const WARNING_NAME: Record<WarningCode, string> = {
  "FR-INS-031a": "Pressure well off target",
  "FR-INS-032": "Odometer below the last reading",
  "FR-INS-033": "Big jump on the odometer",
  "FR-INS-034": "Deeper than last time",
  "FR-INS-035": "Wearing fast",
  "FR-INS-036": "At or below the replacement point",
  "FR-INS-037": "Pressure off target",
  "FR-INS-041": "Uneven wear across the tyre",
};

// NFR-USE-001's budget, made visible while the driver can still see what it
// bought. The value is frozen at the moment the review opens rather than
// ticking: this is a summary of the walk-around, not a stopwatch, and a
// re-rendering clock on every keystroke in the comment box is noise.
function elapsedWords(fromIso: string, to: number): string {
  const seconds = Math.max(0, Math.round((to - Date.parse(fromIso)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds} sec` : `${minutes} min ${seconds % 60} sec`;
}

export function CaptureReview({
  contexts,
  draft,
  donePositionIds,
  onBack,
  onSubmit,
}: {
  contexts: CaptureContext[];
  draft: Draft;
  // Computed once by CaptureFlow from the same predicate the submit payload
  // filters on, so the count the driver reads and the completeness_pct the
  // server stores cannot disagree.
  donePositionIds: ReadonlySet<string>;
  // The shortfall above is only useful if the driver can act on it while they
  // are still standing at the vehicle.
  onBack: () => void;
  onSubmit: (patch: { comment: string | null; defectReport: string | null }) => void;
}) {
  const units = completenessByUnit(contexts, donePositionIds);
  const [comment, setComment] = useState("");
  const [defect, setDefect] = useState("");
  const [openedAt] = useState(() => Date.now());

  const done = units.reduce((n, u) => n + u.done, 0);
  const total = units.reduce((n, u) => n + u.total, 0);

  // The same projection the diagram numbers from, so a driver reading
  // "Position 7" here walks to the wheel they were just standing at.
  const numberOf = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const r of rigPositions(contexts)) map.set(r.position.id, r.displayNumber);
    return map;
  }, [contexts]);

  const flagged = [
    ...draft.warnings.map((w) => ({ key: `rig-${w.code}`, where: "This vehicle", ...w })),
    ...Object.values(draft.positions).flatMap((p) =>
      p.warnings.map((w) => ({
        key: `${p.positionId}-${w.code}`,
        where:
          numberOf.get(p.positionId) === null || numberOf.get(p.positionId) === undefined
            ? "Spare"
            : `Position ${numberOf.get(p.positionId)}`,
        ...w,
      })),
    ),
  ];

  return (
    <section className="cap-screen" aria-labelledby="review-heading">
      <header className="cap-screen-head">
        <p className="cap-eyebrow">Before you send</p>
        <h1 id="review-heading" className="cap-screen-title">
          Review
        </h1>
        <p className="cap-screen-sub">
          {done} of {total} positions done · {elapsedWords(draft.startedAt, openedAt)}
        </p>
      </header>

      {/* FR-INS-065: which unit is short, not just how many are missing. */}
      <ul className="cap-tally">
        {units.map((u) => (
          <li key={u.vehicleId} className="cap-tally-row">
            <span className="cap-tally-id">{u.fleetNumber}</span>
            <span className="cap-tally-count">
              {u.done}/{u.total}
            </span>
            {/* NFR-USE-009: the shortfall is in words, not a colour. */}
            <span className="cap-tally-note">
              {u.done === u.total ? "all done" : `${u.total - u.done} left`}
            </span>
          </li>
        ))}
      </ul>

      <h2 className="cap-eyebrow">What the app found</h2>
      {flagged.length === 0 ? (
        <p className="cap-hint">Nothing to flag.</p>
      ) : (
        <ul className="cap-flags">
          {flagged.map((f) => (
            <li key={f.key} className="cap-flag">
              <span className="cap-flag-where">{f.where}</span>
              <span className="cap-flag-what">{WARNING_NAME[f.code]}</span>
              {f.enteredValue !== null && <span className="cap-flag-val">{f.enteredValue}</span>}
            </li>
          ))}
        </ul>
      )}

      {/* FR-INS-030a and FR-INS-030b are different fields with different
          destinations: the defect report goes to the workshop queue, not to
          the tyre controller, and the label has to say so or drivers will use
          whichever box is nearer. */}
      <label className="cap-field">
        <span className="cap-field-label">Comments about the tyres</span>
        <textarea
          className="cap-textarea"
          rows={2}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </label>
      <label className="cap-field">
        <span className="cap-field-label">Anything else wrong with the vehicle?</span>
        <span className="cap-hint">Goes to the workshop, not the tyre office.</span>
        <textarea
          className="cap-textarea"
          rows={2}
          value={defect}
          onChange={(e) => setDefect(e.target.value)}
        />
      </label>

      <button
        type="button"
        className="cap-primary"
        // 000023 refuses an empty readings array, and the outbox reads that
        // refusal as permanent (outbox.ts) — so an inspection sent with nothing
        // captured could never drain from the queue.
        disabled={done === 0}
        onClick={() => onSubmit({ comment: comment || null, defectReport: defect || null })}
      >
        Submit inspection
      </button>
      {done === 0 && <p className="cap-hint">Capture at least one position before you send.</p>}
      <button type="button" className="cap-secondary" onClick={onBack}>
        ‹ Back to the vehicle
      </button>
    </section>
  );
}
