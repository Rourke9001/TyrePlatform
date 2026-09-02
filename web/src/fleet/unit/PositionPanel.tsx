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
import { ODOMETER_REFUSAL, readOdometer } from "./odometer";
import { tyresKey, unitFitmentsKey, unitKey } from "./queryKeys";
import { MOUNT_ORIENTATIONS, orientationLabel } from "./vocabulary";

// A fit and a removal refuse for different reasons and must say so. Only the
// codes each endpoint can actually raise are listed: app.fit_tyre reaches
// TY009 (a horse fitted without an odometer), TY012, TY014 and the two
// occupancy conflicts, and app.remove_tyre reaches neither occupancy code.
const FIT_WORDING = {
  speakable: ["TY009", "TY012", "TY014", "position_occupied", "tyre_already_fitted"],
  forbidden: "You do not have permission to fit a tyre.",
  fallback: "The tyre could not be fitted. Try again, or call support if it keeps happening.",
};

const REMOVE_WORDING = {
  speakable: ["TY012", "TY014"],
  forbidden: "You do not have permission to remove a tyre.",
  fallback: "The tyre could not be removed. Try again, or call support if it keeps happening.",
};

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
  const [orientation, setOrientation] = useState(MOUNT_ORIENTATIONS[0].value);
  const [fitOdometer, setFitOdometer] = useState("");
  const [reason, setReason] = useState("");
  const [removeTread, setRemoveTread] = useState("");
  const [removeOdometer, setRemoveOdometer] = useState("");
  // Which write was made last, and what it named. Both are needed: the fields
  // clear on success and the read behind them has moved on, so a confirmation
  // could not otherwise name what it confirmed (NFR-USE-010); and both
  // mutations keep their isSuccess for the life of the panel, so a fit
  // followed by a removal would otherwise leave the fit's sentence standing
  // beside the removal's — two claims about one tyre, one of them false.
  const [acted, setActed] = useState<{ kind: "fit" | "remove"; code: string } | null>(null);
  // A refusal this screen raised rather than the server. Setting it drops
  // `acted`, so a standing confirmation never sits beside the sentence saying
  // the next attempt went nowhere.
  const [refused, setRefused] = useState("");

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

  const invalidate = [unitKey(unit.id), unitFitmentsKey(unit.id), tyresKey(tenantKey)];

  const fit = useFormMutation({
    mutate: (vars: NewFitment) => fitTyre(unit.id, vars),
    invalidate,
    onSuccess: () => {
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

  const inStock = (stock.data ?? []).filter((t) => t.state === "IN_STOCK");
  // Advisories belong to the fit that raised them, so they leave with it.
  const warnings = acted?.kind === "fit" ? (fit.result?.warnings ?? []) : [];

  function submitFit(e: FormEvent) {
    e.preventDefault();
    if (tyreId === "" || fitTread.trim() === "") return;
    const odometer = readOdometer(unit.hasOdometer ? fitOdometer : "");
    if (!odometer.ok) {
      setRefused(ODOMETER_REFUSAL);
      setActed(null);
      return;
    }
    setRefused("");
    setActed({ kind: "fit", code: inStock.find((t) => t.id === tyreId)?.displayCode ?? "" });
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
    const odometer = readOdometer(unit.hasOdometer ? removeOdometer : "");
    if (!odometer.ok) {
      setRefused(ODOMETER_REFUSAL);
      setActed(null);
      return;
    }
    setRefused("");
    setActed({ kind: "remove", code: open.displayCode });
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
          <select aria-label="Tyre" value={tyreId} onChange={(e) => setTyreId(e.target.value)}>
            <option value="">Choose…</option>
            {inStock.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayCode}
              </option>
            ))}
          </select>

          <input
            aria-label="Tread (mm)"
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

          {unit.hasOdometer && (
            <input
              aria-label="Odometer"
              inputMode="numeric"
              value={fitOdometer}
              onChange={(e) => setFitOdometer(e.target.value)}
            />
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
          <select aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">Choose…</option>
            {unit.removalReasons.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>

          <input
            aria-label="Tread (mm)"
            inputMode="decimal"
            value={removeTread}
            onChange={(e) => setRemoveTread(e.target.value)}
            required
          />

          {unit.hasOdometer && (
            <input
              aria-label="Odometer"
              inputMode="numeric"
              value={removeOdometer}
              onChange={(e) => setRemoveOdometer(e.target.value)}
            />
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

      {fit.isSuccess && acted?.kind === "fit" && (
        <p role="status">{`${acted.code} was fitted to ${position.code}.`}</p>
      )}
      {remove.isSuccess && acted?.kind === "remove" && (
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
