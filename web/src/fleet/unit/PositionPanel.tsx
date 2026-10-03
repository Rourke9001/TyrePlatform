import { useState } from "react";

import type { FitWarning, Unit, UnitPosition } from "../../api/units";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { RefusalAlert } from "../RefusalAlert";
import { FitForm } from "./FitForm";
import { orientationLabel } from "./vocabulary";
import { RemoveForm } from "./RemoveForm";

// Which write was made last, what it named, and which fitment it acted on:
// needed because a form's own fields and mutation state do not survive the
// swap from FitForm to RemoveForm once a fit succeeds (NFR-USE-010). The
// fitment id keeps the sentence honest after a later rotation changes the
// occupant.
export type ActedSummary =
  | { kind: "fit"; code: string; fitmentId: string; warnings: FitWarning[] }
  | { kind: "remove"; code: string; fitmentId: string };

// The selected position admits one write, a fit when empty or a removal
// when not (D7). Both children report back through onActed/onRefused
// rather than owning this state themselves, because a successful fit turns
// this position occupied and the fit form would unmount, taking its
// warnings and confirmation with it.
export function PositionPanel({ unit, position }: { unit: Unit; position: UnitPosition }) {
  const canManage = useCan("ManageAssets");
  const asDate = useTenantDate();

  const [acted, setActed] = useState<ActedSummary | null>(null);
  // A refusal this screen raised rather than the server. Setting it drops
  // `acted`, so a standing confirmation never sits beside the sentence saying
  // the next attempt went nowhere. An empty message only clears itself,
  // ahead of a submit that turned out to be valid.
  const [refused, setRefused] = useState("");

  function handleRefused(message: string) {
    setRefused(message);
    if (message !== "") {
      setActed(null);
    }
  }

  // RemoveForm is keyed on the fitment id below: a background refetch can
  // swap the occupant of a position out from under a half-typed removal,
  // and readings typed for the old fitment must never close a different
  // one. The remount clears the child's own fields; refused is cleared here
  // since it lives at this level.
  const currentFitmentId = position.fitment?.fitmentId ?? null;
  const [seenFitmentId, setSeenFitmentId] = useState(currentFitmentId);
  if (seenFitmentId !== currentFitmentId) {
    setSeenFitmentId(currentFitmentId);
    setRefused("");
  }

  // Advisories belong to the fit that raised them, so they leave with it.
  const warnings = acted?.kind === "fit" ? acted.warnings : [];
  // A confirmation stands while this position still shows the fitment the
  // write acted on, or shows nothing yet. The invalidated read has not come
  // back. A *different* fitment here belongs to some other write, and a
  // sentence about this one would describe a vehicle that has moved on.
  const actedStillHolds =
    acted !== null && (position.fitment === null || position.fitment.fitmentId === acted.fitmentId);

  return (
    <section className="unit-panel" aria-label={`Position ${position.code}`}>
      <h2>Position {position.code}</h2>

      {position.fitment === null ? (
        <p className="unit-panel-empty">No tyre is fitted here.</p>
      ) : (
        <dl className="unit-panel-facts">
          <dt>Tyre</dt>
          <dd>{position.fitment.displayCode}</dd>
          <dt>Size</dt>
          <dd>{position.fitment.sizeName ?? "—"}</dd>
          <dt>Retreads</dt>
          <dd>{position.fitment.retreadCount}</dd>
          <dt>Orientation</dt>
          <dd>{orientationLabel(position.fitment.mountOrientation)}</dd>
          <dt>Fitted</dt>
          <dd>{asDate(position.fitment.fittedAt)}</dd>
          <dt>Last tread</dt>
          <dd>{position.fitment.lastTreadMm ?? "—"}</dd>
        </dl>
      )}

      {canManage && position.fitment === null && (
        <FitForm unit={unit} position={position} onActed={setActed} onRefused={handleRefused} />
      )}

      {canManage && position.fitment !== null && (
        <RemoveForm
          key={currentFitmentId}
          unit={unit}
          position={position}
          onActed={setActed}
          onRefused={handleRefused}
        />
      )}

      {acted?.kind === "fit" && actedStillHolds && (
        <p role="status">{`${acted.code} was fitted to ${position.code}.`}</p>
      )}
      {acted?.kind === "remove" && actedStillHolds && (
        <p role="status">{`${acted.code} was removed from ${position.code}.`}</p>
      )}

      {/* app.fit_tyre's advisories, not refusals: the fit happened, and a
          dual-mate gap or a mixed pattern is something to know rather than
          something to undo. Rendering them in an alert would say the
          opposite (NFR-USE-005). */}
      {warnings.length > 0 && (
        <ul role="status" aria-label="Warnings" className="unit-panel-warnings">
          {warnings.map((w) => (
            <li key={w.code} data-warning-code={w.code}>
              {w.message}
            </li>
          ))}
        </ul>
      )}

      <RefusalAlert message={refused} />
    </section>
  );
}
