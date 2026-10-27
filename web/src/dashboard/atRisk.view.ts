import type { AtRiskClass, TyreAtRisk } from "../api/dashboard";
import { absenceLabel, basisLabel, judgedAtLabel, treadSourceLabel } from "../domain/vocabulary";
import { formatCount, formatMm, plural } from "../format/numbers";
import { formatTreadAge } from "../format/treadAge";
import type { MoneyFigure } from "./dashboard.view";

// The at-risk list as the page shows it (ADR-0022). The route is gated on
// ViewValuation (routes.tsx), so money is visible here by construction; a
// null is an empty class or an unvalued one (U36).

export interface AtRiskClassView {
  value: MoneyFigure;
  detail: string;
}

// U47: the hero's own words for the same breakdown, so the figure and the
// list it opens read alike.
export function atRiskClassView(c: AtRiskClass): AtRiskClassView {
  return {
    value: {
      value: c.casingValueAtRisk,
      visible: true,
      set: { tyreCount: c.tyreCount, empty: absenceLabel("noneAtRisk") },
    },
    detail: `${plural(c.tyreCount, "tyre", "tyres")}: ${formatCount(c.actualCount)} at actual cost, ${formatCount(c.estimatedOrAuditCount)} estimated or audit, of which ${formatCount(c.auditCount)} audit; ${formatCount(c.unvaluedCount)} unvalued`,
  };
}

// U17: a depot view names its depot, or one depot until its name is known.
export function atRiskLede(
  judgedAt: string,
  depot: string | undefined,
  depotName: string | undefined,
): string {
  const parts = [`Tyres at or below the removal threshold, judged ${judgedAtLabel(judgedAt)}`];
  if (depot !== undefined) parts.push(`at ${depotName ?? absenceLabel("unnamedDepot")}`);
  return parts.join(", ");
}

export interface AtRiskRowView {
  key: string;
  code: string;
  vehicleId: string;
  fleetNumber: string;
  position: string;
  tread: string;
  source: string;
  read: string;
  value: MoneyFigure;
  basis: string;
}

// FR-DSH-017, U47: each tyre with its casing value and the basis it was
// priced on (ADR-0010, TYRE-176).
export function atRiskRows(
  tyres: TyreAtRisk[],
  formatInstant: (at: string) => string,
): AtRiskRowView[] {
  return tyres.map((t) => ({
    key: t.tyreId,
    code: t.displayCode,
    vehicleId: t.vehicleId,
    fleetNumber: t.fleetNumber,
    position: t.positionCode,
    tread: `${formatMm(t.currentTreadMm)} of ${formatMm(t.removalThresholdMm)}`,
    source: treadSourceLabel(t.treadSource),
    // FR-TYR-017: the read's age joins its date in this cell, never a
    // column of its own.
    read:
      t.readAt === null
        ? absenceLabel("undated")
        : t.treadAgeDays === null
          ? formatInstant(t.readAt)
          : `${formatInstant(t.readAt)}, ${formatTreadAge(t.treadAgeDays)}`,
    value: { value: t.casingValue, visible: true },
    basis: basisLabel(t.casingBasis),
  }));
}
