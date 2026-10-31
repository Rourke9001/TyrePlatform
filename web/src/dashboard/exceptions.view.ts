import type { ExceptionRow, ExceptionsParams } from "../api/dashboard";
import {
  absenceLabel,
  judgedAtLabel,
  SEVERITY_CODES,
  severityLabel,
  subjectPositionLabel,
} from "../domain/vocabulary";
import { formatMm, formatPct, plural } from "../format/numbers";
import { formatTreadAge } from "../format/treadAge";

// The exceptions list as the page shows it (ADR-0022): the filtered table
// the dashboard's tiles link to, judged as inspected (U18).

export interface Option {
  value: string;
  label: string;
}

// The URL spells includeResolved as resolved; this and
// writeExceptionsParams are the only two places that know both spellings.
// The order read is the order the request URL carries.
export function readExceptionsParams(search: URLSearchParams): ExceptionsParams {
  const params: ExceptionsParams = {};
  const severity = search.get("severity");
  const rule = search.get("rule");
  const depot = search.get("depot");
  if (severity) params.severity = severity;
  if (rule) params.rule = rule;
  if (depot) params.depot = depot;
  if (search.get("resolved") === "true") params.includeResolved = true;
  return params;
}

export function writeExceptionsParams(params: ExceptionsParams): URLSearchParams {
  const out = new URLSearchParams();
  if (params.severity) out.set("severity", params.severity);
  if (params.rule) out.set("rule", params.rule);
  if (params.depot) out.set("depot", params.depot);
  if (params.includeResolved) out.set("resolved", "true");
  return out;
}

// U18: the count line names its clock, since the at-risk list two clicks
// away is judged today and the two can disagree. U17: a depot view names
// its depot.
export function exceptionsLede(
  count: number,
  judgedAt: string,
  depot: string | undefined,
  depotName: string | undefined,
): string {
  const parts = [plural(count, "exception", "exceptions"), judgedAtLabel(judgedAt)];
  if (depot !== undefined) parts.push(`at ${depotName ?? absenceLabel("unnamedDepot")}`);
  return parts.join(", ");
}

export function severityOptions(): Option[] {
  return [
    { value: "", label: "All severities" },
    ...SEVERITY_CODES.map((s) => ({ value: s, label: severityLabel(s) })),
  ];
}

// The codes present plus the one chosen, so a link from a tile always
// finds its rule in the list.
export function ruleOptions(rows: ExceptionRow[], rule: string | undefined): Option[] {
  const codes = Array.from(new Set(rows.map((r) => r.ruleCode).concat(rule ? [rule] : []))).sort();
  return [{ value: "", label: "All rules" }, ...codes.map((c) => ({ value: c, label: c }))];
}

export interface ExceptionRowView {
  key: string;
  ruleName: string;
  ruleCode: string;
  severity: string;
  // The critical edge, beside the badge's word that says why.
  tone?: "critical";
  vehicleId: string;
  fleetNumber: string;
  position: string;
  measure: string;
  seen: string;
  replaced: string;
}

// U18: every v_exception row carries the threshold it was judged against,
// so the measure and its threshold share a unit and the row explains itself.
function measure(row: ExceptionRow): string {
  if (row.measureMm !== null && row.thresholdMm !== null)
    return `${formatMm(row.measureMm)} of ${formatMm(row.thresholdMm)}`;
  if (row.measurePct !== null && row.thresholdPct !== null)
    return `${formatPct(row.measurePct)} of ${formatPct(row.thresholdPct)}`;
  return absenceLabel("unmeasured");
}

export function exceptionRows(
  rows: ExceptionRow[],
  formatInstant: (at: string) => string,
): ExceptionRowView[] {
  return rows.map((r) => ({
    key: `${r.ruleCode}:${r.subjectId}:${r.inspectionId}`,
    ruleName: r.ruleName,
    ruleCode: r.ruleCode,
    severity: r.severity,
    tone: r.severity === "CRITICAL" ? "critical" : undefined,
    vehicleId: r.vehicleId,
    fleetNumber: r.fleetNumber,
    position: subjectPositionLabel(r.subjectType, r.positionCode, r.positionCode2, r.isSpare),
    measure: measure(r),
    // FR-TYR-017: the sheet's age joins its time in this cell, never a
    // column of its own.
    seen: `${formatInstant(r.observedAt)}, ${formatTreadAge(r.observedAgeDays)}`,
    replaced: r.resolvedByFitment ? "Yes" : "No",
  }));
}
