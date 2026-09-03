import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import { fetchTyres } from "../../api/tyres";
import {
  fitTyre,
  removeFitment,
  type NewFitment,
  type Removal,
  type Unit,
  type UnitPosition,
} from "../../api/units";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { useFormMutation } from "../useFormMutation";
import { byNaturalCode } from "./naturalOrder";
import { ODOMETER_REFUSAL, ODOMETER_REQUIRED, readOdometer } from "./odometer";
import { openFitmentsKey, tyresKey, unitFitmentsKey, unitKey } from "./queryKeys";
import { MOUNT_ORIENTATIONS, orientationLabel } from "./vocabulary";

// A fit and a removal refuse for different reasons and must say so. Only the
// codes each endpoint can actually raise are listed: app.fit_tyre reaches
// TY009 (FR-FIT-002: a unit that has an odometer needs the reading), TY012,
// TY014 and the two occupancy conflicts, and app.remove_tyre reaches TY009 and
// neither occupancy code — 000025's fitment_odometer_matches_unit_kind fires
// BEFORE INSERT OR UPDATE, so the removal's own closing UPDATE answers to it
// as the fit's INSERT does.
const FIT_WORDING = {
  speakable: ["TY009", "TY012", "TY014", "position_occupied", "tyre_already_fitted"],
  forbidden: "You do not have permission to fit a tyre.",
  fallback: "The tyre could not be fitted. Try again, or call support if it keeps happening.",
};

const REMOVE_WORDING = {
  speakable: ["TY009", "TY012", "TY014"],
  forbidden: "You do not have permission to remove a tyre.",
  fallback: "The tyre could not be removed. Try again, or call support if it keeps happening.",
};

// CR-012 subtracts the fitted reading from this one to get the distance the
// tyre ran, and app.fitment's odometer_does_not_decrease (000001) refuses a
// smaller one as a 23514 the API can only report as a generic
// invalid_submission. Refusing here instead names the reading to beat.
function belowFittedOdometer(fitted: number): string {
  return `The odometer cannot be below ${fitted}, the reading this tyre was fitted at.`;
}

// The selected position: what it carries, and the one write it admits — a
// fit when it is empty, a removal when it is not (D7). Both mutations are
// held here rather than in two child forms because a successful fit turns
// this position into an occupied one: a child holding the result would
// unmount on the invalidated read and take its warnings with it, exactly
// when there is something to read.
export function PositionPanel({ unit, position }: { unit: Unit; position: UnitPosition }) {
  const canManage = useCan("ManageAssets");
  const tenantKey = getDevTenantId() ?? "default";
  const asDate = useTenantDate();

  const [tyreId, setTyreId] = useState("");
  const [fitTread, setFitTread] = useState("");
  // D13: an unasserted orientation is recorded as UNKNOWN, never guessed —
  // mountOrientation is a required field on the wire (fitTyreRequest.validate,
  // fitments.go) so whatever this holds at submit is written to an immutable
  // row (rule 3), and a default of MARK_OUTBOARD would record a positive
  // mounting fact nobody asserted.
  const [orientation, setOrientation] = useState("UNKNOWN");
  const [fitOdometer, setFitOdometer] = useState("");
  const [reason, setReason] = useState("");
  const [removeTread, setRemoveTread] = useState("");
  const [removeOdometer, setRemoveOdometer] = useState("");
  // Which write was made last, what it named, and which fitment it acted on.
  // The first two are needed because the fields clear on success and the read
  // behind them has moved on, so a confirmation could not otherwise name what
  // it confirmed (NFR-USE-010), and because both mutations keep their
  // isSuccess for the life of the panel — a fit followed by a removal would
  // otherwise leave the fit's sentence standing beside the removal's. The
  // fitment id is what keeps the sentence honest afterwards: a rotation
  // elsewhere on the unit can put a different tyre in this position, and
  // "TY007 was fitted to POS1" is then a claim about a position holding
  // something else.
  const [acted, setActed] = useState<{
    kind: "fit" | "remove";
    code: string;
    fitmentId: string | null;
  } | null>(null);
  // A refusal this screen raised rather than the server. Setting it drops
  // `acted`, so a standing confirmation never sits beside the sentence saying
  // the next attempt went nowhere.
  const [refused, setRefused] = useState("");

  // The removal form's own fields, reset during render rather than in an
  // effect (react-hooks/set-state-in-effect) — an extra commit is not needed
  // to derive this state from a prop. A background refetch (window focus, or
  // any write's invalidation) can swap the occupant of this position out from
  // under a half-typed removal, and readings typed for the old fitment must
  // never close a different one (the fitment closed is read off
  // `position.fitment` at submit, not carried in state).
  const currentFitmentId = position.fitment?.fitmentId ?? null;
  const [seenFitmentId, setSeenFitmentId] = useState(currentFitmentId);
  if (seenFitmentId !== currentFitmentId) {
    setSeenFitmentId(currentFitmentId);
    setReason("");
    setRemoveTread("");
    setRemoveOdometer("");
    setRefused("");
  }

  // GET /api/tyres takes no state parameter (fetchTyres' own options are code,
  // on and awaitingCost), so the register is read whole and narrowed to stock
  // below. The key segment says "register" because that is what is cached; a
  // segment naming a filter the request never sent would be a claim the next
  // reader has to disprove.
  const stock = useQuery({
    queryKey: [...tyresKey(tenantKey), "register"],
    queryFn: () => fetchTyres(),
    enabled: canManage && position.fitment === null,
  });

  const invalidate = [
    unitKey(unit.id),
    unitFitmentsKey(unit.id),
    tyresKey(tenantKey),
    openFitmentsKey(tenantKey),
  ];

  const fit = useFormMutation({
    mutate: (vars: NewFitment) => fitTyre(unit.id, vars),
    invalidate,
    onSuccess: (result) => {
      // Merged rather than set: the code was read off the picker at submit,
      // which has been cleared by the time the fitment id this produced is
      // known.
      setActed((prev) => (prev === null ? prev : { ...prev, fitmentId: result.fitmentId }));
      setTyreId("");
      setFitTread("");
      setFitOdometer("");
    },
  });

  const remove = useFormMutation({
    mutate: (vars: { fitmentId: string; body: Removal }) =>
      removeFitment(vars.fitmentId, vars.body),
    invalidate,
    onSuccess: () => {
      setReason("");
      setRemoveTread("");
      setRemoveOdometer("");
    },
  });

  const inStock = (stock.data ?? [])
    .filter((t) => t.state === "IN_STOCK")
    .sort((a, b) => byNaturalCode(a.displayCode, b.displayCode));
  // Advisories belong to the fit that raised them, so they leave with it.
  const warnings = acted?.kind === "fit" ? (fit.result?.warnings ?? []) : [];
  // A confirmation stands while this position still shows the fitment the
  // write acted on, or shows nothing yet — the invalidated read has not come
  // back. A *different* fitment here belongs to some other write, and a
  // sentence about this one would describe a vehicle that has moved on.
  const actedStillHolds =
    acted !== null && (position.fitment === null || position.fitment.fitmentId === acted.fitmentId);

  function submitFit(e: FormEvent) {
    e.preventDefault();
    if (tyreId === "" || fitTread.trim() === "") return;
    if (unit.hasOdometer && fitOdometer.trim() === "") {
      setRefused(ODOMETER_REQUIRED);
      setActed(null);
      return;
    }
    const odometer = readOdometer(unit.hasOdometer ? fitOdometer : "");
    if (!odometer.ok) {
      setRefused(ODOMETER_REFUSAL);
      setActed(null);
      return;
    }
    setRefused("");
    setActed({
      kind: "fit",
      code: inStock.find((t) => t.id === tyreId)?.displayCode ?? "",
      fitmentId: null,
    });
    fit.submit({
      tyreId,
      positionId: position.id,
      treadMm: fitTread.trim(),
      mountOrientation: orientation,
      odometer: odometer.value,
    });
  }

  function submitRemove(e: FormEvent) {
    e.preventDefault();
    const open = position.fitment;
    if (open === null || reason === "" || removeTread.trim() === "") return;
    if (unit.hasOdometer && removeOdometer.trim() === "") {
      setRefused(ODOMETER_REQUIRED);
      setActed(null);
      return;
    }
    const odometer = readOdometer(unit.hasOdometer ? removeOdometer : "");
    if (!odometer.ok) {
      setRefused(ODOMETER_REFUSAL);
      setActed(null);
      return;
    }
    if (
      odometer.value !== undefined &&
      open.fittedOdometer !== null &&
      odometer.value < open.fittedOdometer
    ) {
      setRefused(belowFittedOdometer(open.fittedOdometer));
      setActed(null);
      return;
    }
    setRefused("");
    setActed({ kind: "remove", code: open.displayCode, fitmentId: open.fitmentId });
    remove.submit({
      fitmentId: open.fitmentId,
      body: { reason, treadMm: removeTread.trim(), odometer: odometer.value },
    });
  }

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
        <form className="unit-panel-form" onSubmit={submitFit}>
          {stock.isError ? (
            <div className="note-card" role="alert">
              <h3>Tyres didn&apos;t load</h3>
              <p>The server could not be reached. Check your connection, then retry.</p>
              <button className="btn-primary" type="button" onClick={() => void stock.refetch()}>
                Retry
              </button>
            </div>
          ) : (
            <>
              <label htmlFor={`fit-tyre-${position.id}`}>Tyre</label>
              <select
                id={`fit-tyre-${position.id}`}
                value={tyreId}
                onChange={(e) => setTyreId(e.target.value)}
              >
                <option value="" disabled={stock.isPending}>
                  {stock.isPending ? "Loading…" : "Choose…"}
                </option>
                {inStock.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.displayCode}
                  </option>
                ))}
              </select>
            </>
          )}

          <label htmlFor={`fit-tread-${position.id}`}>Tread (mm)</label>
          <input
            id={`fit-tread-${position.id}`}
            inputMode="decimal"
            value={fitTread}
            onChange={(e) => setFitTread(e.target.value)}
            required
          />

          <div role="radiogroup" aria-label="Mount orientation" className="unit-panel-radios">
            {MOUNT_ORIENTATIONS.map((o) => (
              <label key={o.value}>
                <input
                  type="radio"
                  name={`orientation-${position.id}`}
                  value={o.value}
                  checked={orientation === o.value}
                  onChange={() => setOrientation(o.value)}
                />
                {o.label}
              </label>
            ))}
          </div>

          {/* FR-FIT-002: a unit that has an odometer needs the reading, and
              the trigger that enforces it (000025) refuses the whole write.
              Asking for it here costs a tap; leaving it optional costs a
              refusal the controller has to read and retry. */}
          {unit.hasOdometer && (
            <>
              <label htmlFor={`fit-odometer-${position.id}`}>Odometer</label>
              <input
                id={`fit-odometer-${position.id}`}
                inputMode="numeric"
                value={fitOdometer}
                onChange={(e) => setFitOdometer(e.target.value)}
                required
              />
            </>
          )}

          <button
            className="btn-primary btn-compact"
            type="submit"
            disabled={tyreId === "" || fit.isPending}
          >
            {fit.isPending ? "Fitting…" : "Fit tyre"}
          </button>
        </form>
      )}

      {canManage && position.fitment !== null && (
        <form className="unit-panel-form" onSubmit={submitRemove}>
          {/* FR-FIT-008: which reasons exist is tenant configuration, read off
              the unit rather than listed here (rule 5). */}
          <label htmlFor={`remove-reason-${position.id}`}>Reason</label>
          <select
            id={`remove-reason-${position.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="">Choose…</option>
            {unit.removalReasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>

          <label htmlFor={`remove-tread-${position.id}`}>Tread (mm)</label>
          <input
            id={`remove-tread-${position.id}`}
            inputMode="decimal"
            value={removeTread}
            onChange={(e) => setRemoveTread(e.target.value)}
            required
          />

          {unit.hasOdometer && (
            <>
              <label htmlFor={`remove-odometer-${position.id}`}>Odometer</label>
              <input
                id={`remove-odometer-${position.id}`}
                inputMode="numeric"
                value={removeOdometer}
                onChange={(e) => setRemoveOdometer(e.target.value)}
                required
              />
            </>
          )}

          <button
            className="btn-primary btn-compact"
            type="submit"
            disabled={reason === "" || remove.isPending}
          >
            {remove.isPending ? "Removing…" : "Remove tyre"}
          </button>
        </form>
      )}

      {fit.isSuccess && acted?.kind === "fit" && actedStillHolds && (
        <p role="status">{`${acted.code} was fitted to ${position.code}.`}</p>
      )}
      {remove.isSuccess && acted?.kind === "remove" && actedStillHolds && (
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

      {refused !== "" && <p role="alert">{refused}</p>}
      {fit.error !== null && acted?.kind === "fit" && (
        <p role="alert">{refusalMessage(fit.error, FIT_WORDING)}</p>
      )}
      {remove.error !== null && acted?.kind === "remove" && (
        <p role="alert">{refusalMessage(remove.error, REMOVE_WORDING)}</p>
      )}
    </section>
  );
}
