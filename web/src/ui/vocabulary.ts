// The dashboard's words, written once so no page spells one itself (U48).
// The server owns the code vocabularies (severity, judgedAt, unavailable
// reasons, tread source, cost basis, inflation bands), so each code map
// passes an unknown code through rather than throwing; absenceLabel is a
// closed set the pages choose from, and the number helpers format every
// count (U55).

import { groupThousands } from "../format/groupThousands";

// groupThousands takes an integer's digits, so a count or percentage is
// made whole first, rounding half away from zero as Intl.NumberFormat did.
function wholeDigits(n: number): string {
  return String(Math.sign(n) * Math.round(Math.abs(n)));
}

export function formatCount(n: number): string {
  return groupThousands(wholeDigits(n));
}

// The noun for a count that renders apart from it, as a tile's value does.
export function pluralWord(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${pluralWord(n, one, many)}`;
}

// en-ZA's decimal separator is a comma in current ICU (Intl.NumberFormat
// would render "4,0 mm" beside formatRand's "R16,537.50"), so tread uses
// toFixed and a point instead. A tread value on the wire is whole or half
// millimetres, the capture keypad has a half key and no decimal point, and
// the owner fixed the display at one decimal always (TYRE-238 comment 12938).
export function formatMm(n: number): string {
  return `${n.toFixed(1)} mm`;
}

// A percentage on the wire is a SQL column (pctOfGroup, pctOfClassified);
// this rounds for display and never computes one.
export function formatPct(n: number): string {
  return `${groupThousands(wholeDigits(n))}%`;
}

// FR-DSH-003: most urgent first, the one order the tiles and the
// exceptions filter both list.
export const SEVERITY_CODES: readonly string[] = ["CRITICAL", "WARNING", "INFO"];

const SEVERITY_LABELS: Record<string, string> = {
  INFO: "Info",
  WARNING: "Warning",
  CRITICAL: "Critical",
};

export function severityLabel(code: string): string {
  return SEVERITY_LABELS[code] ?? code;
}

// U18: exceptions are judged at the inspection's submitted_at, the
// register and value at risk today, unit status on the tenant's day. The
// page says which beside every figure, from the wire's own judgedAt.
const JUDGED_AT_LABELS: Record<string, string> = {
  SUBMITTED_AT: "as inspected",
  TODAY: "today",
  TENANT_TODAY: "on the tenant's calendar day",
  LATEST_READING: "at the latest reading",
  PERIOD: "for the period",
  AS_AT: "as at the chosen date",
};

export function judgedAtLabel(code: string): string {
  return JUDGED_AT_LABELS[code] ?? code;
}

// TENANT_ONLY has two readers (spec U32; PR #64): a tenant-wide actor who
// narrowed to a depot can widen again, a depot-scoped actor cannot
// (TYRE-268 owns the depot dimension).
export function unavailableLabel(code: string, depotFiltered: boolean): string {
  switch (code) {
    case "TENANT_ONLY":
      return depotFiltered
        ? "Tenant-wide only. Clear the depot filter to see it."
        : "Not available for a depot view yet.";
    case "NO_WINDOW":
      return "No compliance window is configured for this tenant.";
    case "NO_HORIZON":
      return "No forecast horizon is configured for this tenant.";
    default:
      return `Not available (${code}).`;
  }
}

// U29: AUDIT is the documented umbrella for every tread measured outside
// an inspection (onboarding audit, fitment, removal, rotation, retread
// return); the label says that rather than naming one of them.
const TREAD_SOURCE_LABELS: Record<string, string> = {
  READING: "inspection reading",
  AUDIT: "measured outside an inspection",
};

export function treadSourceLabel(code: string): string {
  return TREAD_SOURCE_LABELS[code] ?? code;
}

// The register's cost_source vocabulary (ADR-0010, TYRE-176).
const BASIS_LABELS: Record<string, string> = {
  ACTUAL: "actual cost",
  ESTIMATED: "estimated",
  AUDIT: "audit valuation",
  UNVALUED: "not valued",
};

export function basisLabel(code: string): string {
  return BASIS_LABELS[code] ?? code;
}

// A band bound is whole or half millimetres, so one decimal at most, with a
// point (see formatMm); a whole bound stays "5", not "5.0", to match the
// accepted mockup's "0 to under 5 mm".
function formatBound(mm: number): string {
  return Number.isInteger(mm) ? String(mm) : mm.toFixed(1);
}

// U40: a band is [lower, upper) and the last band is open. The wire also
// carries bandLabel, which TYRE-270 shows can name a range the band does
// not cover, so nothing renders it.
export function bandRangeLabel(lowerMm: number, upperExclusiveMm: number | null): string {
  const lower = formatBound(lowerMm);
  if (upperExclusiveMm === null) return `${lower} mm and over`;
  return `${lower} to under ${formatBound(upperExclusiveMm)} mm`;
}

// The five inflation bands as migration 000045 names them; the percentages
// that assign a reading to one are tenant configuration (rule 5). The words
// are relative to the tenant's configured target pressure and make no
// safety or legal judgment (TYRE-271). If the database adds a band,
// db/tests/004_tests.sql fails first and this list moves with it.
export const INFLATION_BAND_KEYS = [
  "dangerously_under",
  "under",
  "correct",
  "over",
  "dangerously_over",
] as const;

const INFLATION_BAND_LABELS: Record<(typeof INFLATION_BAND_KEYS)[number], string> = {
  dangerously_under: "Critically under target",
  under: "Under target",
  correct: "Within target",
  over: "Over target",
  dangerously_over: "Critically over target",
};

export function inflationBandLabel(key: string): string {
  return (INFLATION_BAND_LABELS as Record<string, string>)[key] ?? key;
}

// U48, NFR-PRO-002: where the wire sends null, an empty set or an empty
// list rather than a code, the page names what is absent, once, here, and
// never renders it as 0.
const ABSENCE_LABELS = {
  unclassifiedShare: "none classified",
  unmeasured: "not measured",
  neverMeasured: "never",
  unknown: "unknown",
  undated: "not dated",
  noSpreadConfigured: "No width spread is configured for this tenant.",
  noTyres: "No tyres in this view",
  noTyresBody: "Nothing is fitted or in stock here, so there is nothing to value.",
  noneAtRisk: "None at risk",
  noSparesAtRisk: "No spares at or below the removal threshold",
  noTyresAtRisk: "Nothing at or below the removal threshold",
  noTyresAtRiskBody: "Every fitted tyre in this view reads above the configured removal threshold.",
  noReadingsInPeriod: "No readings in the period",
  noSpares: "No spares",
  noSparesBody: "No spare position carries a tyre in this view.",
  noOpenExceptions: "No open exceptions",
  noOpenExceptionsBody:
    "Nothing the configured rules flag at the latest inspection of any unit in this view.",
  unnamedDepot: "one depot",
} as const;

export type Absence = keyof typeof ABSENCE_LABELS;

export function absenceLabel(kind: Absence): string {
  return ABSENCE_LABELS[kind];
}

// U48: an exception's subject in words.
export function subjectPositionLabel(
  subjectType: string,
  positionCode: string | null,
  positionCode2: string | null,
  isSpare: boolean,
): string {
  if (subjectType === "VEHICLE") return "whole unit";
  if (positionCode && positionCode2) return `${positionCode} and ${positionCode2}`;
  if (positionCode) return positionCode;
  return isSpare ? "spare" : absenceLabel("unknown");
}
