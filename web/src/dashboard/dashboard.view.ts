import type {
  DashboardBody,
  EstateRow,
  ForecastSummary,
  InflationBand,
  InflationCompliance,
  SpareRow,
  TreadBand,
} from "../api/dashboard";
import type { Money } from "../api/money";
import type { Band } from "../ui/BandChart";
import type { ProvenanceSegment } from "../ui/ProvenanceBar";
import {
  absenceLabel,
  bandRangeLabel,
  inflationBandLabel,
  judgedAtLabel,
  SEVERITY_CODES,
  severityLabel,
  treadSourceLabel,
  unavailableLabel,
} from "../domain/vocabulary";
import { formatCount, formatMm, formatPct, plural, pluralWord } from "../format/numbers";
import { formatTreadAge } from "../format/treadAge";
import { withDepot } from "./dashboardParams";

// The overview's figures as the page shows them (ADR-0022). Money is handed
// on as the wire string with what decides its absence, and the screen
// formats it with the tenant's currency (rule 2, useMoneyText.ts).
export interface MoneyFigure {
  value: Money | null;
  visible: boolean;
  // U36, U44: the set a sum is over. An empty one reads as its own words,
  // never "Not valued"; Hidden still wins.
  set?: { tyreCount: number; empty: string };
}

// A line of words around one money figure, joined once it is formatted.
export type MoneyLine = { text: string } | { before: string; money: MoneyFigure; after: string };

export type Tone = "default" | "critical" | "warning";

export interface TileLink {
  to: string;
  label: string;
}

type Formatter = (at: string) => string;

// U17, rule 6: every figure shares one as-at instant, named once with the
// tenant's zone.
export function dashboardLede(
  body: DashboardBody,
  timezone: string | undefined,
  formatInstant: Formatter,
): string {
  const parts = [`As at ${formatInstant(body.asAt)}`];
  if (timezone !== undefined) parts.push(timezone);
  if (body.scope.level === "DEPOTS") {
    parts.push(`across your ${plural(body.scope.depotCount, "depot", "depots")}`);
  }
  return parts.join(", ");
}

export interface HeroView {
  figure: MoneyFigure;
  tone: "default" | "critical";
  qualifier: string;
  footnote: string;
  segments: ProvenanceSegment[];
  spare: MoneyLine;
  link?: TileLink;
}

// FR-DSH-017: the one hero figure, with its provenance and the spares
// disclosed apart (BR-RPT-001).
export function heroView(
  body: Pick<DashboardBody, "valueAtRisk" | "belowThreshold" | "moneyVisible">,
  depot?: string,
): HeroView {
  const { valueAtRisk, belowThreshold, moneyVisible } = body;
  const { running, spare } = valueAtRisk;
  const spareTail = spare.unvaluedCount > 0 ? `, ${formatCount(spare.unvaluedCount)} unvalued` : "";
  return {
    figure: {
      value: running.casingValueAtRisk,
      visible: moneyVisible,
      set: { tyreCount: running.tyreCount, empty: absenceLabel("noneAtRisk") },
    },
    tone:
      moneyVisible && running.tyreCount > 0 && running.casingValueAtRisk !== null
        ? "critical"
        : "default",
    // U18: the register's today count, not the exception count, which is
    // judged at each unit's latest inspection.
    qualifier: `from ${plural(belowThreshold.running, "running tyre", "running tyres")} at or below the removal threshold ${judgedAtLabel(belowThreshold.judgedAt)}`,
    footnote: `${formatCount(running.actualCount)} at actual cost, ${formatCount(running.estimatedOrAuditCount)} estimated or audit, of which ${formatCount(running.auditCount)} audit; ${formatCount(running.unvaluedCount)} unvalued`,
    segments: [
      { key: "actual", label: "Actual", count: running.actualCount },
      { key: "estimated", label: "Estimated or audit", count: running.estimatedOrAuditCount },
      { key: "unvalued", label: "Unvalued", count: running.unvaluedCount },
    ],
    // U36, U44: an empty spare class is its absence, the whole line; Hidden
    // still wins over it.
    spare:
      moneyVisible && spare.tyreCount === 0
        ? { text: absenceLabel("noSparesAtRisk") }
        : {
            before: "Spares: ",
            money: { value: spare.casingValueAtRisk, visible: moneyVisible },
            after: ` from ${plural(spare.tyreCount, "tyre", "tyres")}${spareTail}`,
          },
    // D7: /at-risk is gated on ViewValuation, so a reader without it is not
    // offered a link to a refusal.
    link: moneyVisible
      ? { to: withDepot("/at-risk", depot), label: "See the at-risk list" }
      : undefined,
  };
}

export interface EstateTile {
  value: MoneyFigure;
  unvalued: string;
  segments: ProvenanceSegment[];
}

export interface EstateView {
  judged: string;
  tread: EstateTile;
  casing: EstateTile;
  total: MoneyLine;
}

// FR-DSH-002: tread and casing, each with its own provenance split; the
// casing partitions are the view's four disjoint counts (U27).
function estateView(estate: EstateRow, moneyVisible: boolean): EstateView {
  const money = (value: Money | null): MoneyFigure => ({
    value,
    visible: moneyVisible,
    set: { tyreCount: estate.tyreCount, empty: absenceLabel("noTyres") },
  });
  const of = (count: number) =>
    `${formatCount(count)} of ${formatCount(estate.tyreCount)} unvalued`;
  // U44, 000049: the total is a partial sum when one side has no valued
  // member, so it discloses both sides' unvalued counts when either is not 0.
  const partial =
    estate.unvaluedCount > 0 || estate.casingUnvaluedCount > 0
      ? `; tread ${of(estate.unvaluedCount)}, casing ${of(estate.casingUnvaluedCount)}`
      : "";
  return {
    // U48: estateRowJSON carries no judgedAt; loadEstate values the estate
    // as at today, so the page names that clock itself.
    judged: judgedAtLabel("TODAY"),
    tread: {
      value: money(estate.treadValue),
      unvalued: of(estate.unvaluedCount),
      segments: [
        { key: "actual", label: "Actual", count: estate.actualCount },
        { key: "estimated", label: "Estimated", count: estate.estimatedCount },
        { key: "unvalued", label: "Unvalued", count: estate.unvaluedCount },
      ],
    },
    casing: {
      value: money(estate.casingValue),
      unvalued: of(estate.casingUnvaluedCount),
      segments: [
        { key: "actual", label: "Actual", count: estate.casingActualCount },
        { key: "estimated", label: "Estimated", count: estate.casingEstimatedCount },
        { key: "audit", label: "Audit", count: estate.casingAuditCount },
        { key: "unvalued", label: "Unvalued", count: estate.casingUnvaluedCount },
      ],
    },
    // U44: an empty estate's total line is the absence alone; "across 0
    // tyres" would only restate it.
    total:
      moneyVisible && estate.tyreCount === 0
        ? { text: `${absenceLabel("noTyres")}.` }
        : {
            before: "",
            money: money(estate.totalValue),
            after: ` across ${plural(estate.tyreCount, "tyre", "tyres")} in total${partial}.`,
          },
  };
}

export interface SeverityLine {
  code: string;
  text: string;
  to: string;
}

export interface TilesView {
  estate: EstateView;
  exceptions: {
    value: string;
    tone: Tone;
    detail: string;
    severities: SeverityLine[];
    judged: string;
    link: TileLink;
  };
  below: { value: string; tone: Tone; detail: string; judged: string; link?: TileLink };
  units: {
    judged: string;
    coverage: { value: string; detail: string };
    overdue: { value: string; tone: Tone };
    stale: { value: string; detail?: string; tone: Tone };
    rigs: { value: string; tone: Tone; link?: TileLink };
  };
}

// U17: a tile and the list it links to count the same units, so each link
// carries the depot (withDepot).
export function tilesView(body: DashboardBody, depot?: string): TilesView {
  const { exceptions, belowThreshold, units, moneyVisible } = body;
  const known = SEVERITY_CODES.filter((s) => s in exceptions.bySeverity);
  const unknown = Object.keys(exceptions.bySeverity).filter((s) => !SEVERITY_CODES.includes(s));
  return {
    estate: estateView(body.estate, moneyVisible),
    // FR-DSH-003 counts v_exception rows, judged as inspected (U18).
    exceptions: {
      value: formatCount(exceptions.open),
      tone: exceptions.urgent > 0 ? "critical" : "default",
      detail: `${plural(exceptions.urgent, "urgent", "urgent")}; ${plural(exceptions.rulesConfigured, "rule configured", "rules configured")}`,
      severities: known.concat(unknown).map((code) => ({
        code,
        text: `${severityLabel(code)} ${formatCount(exceptions.bySeverity[code])}`,
        to: withDepot(`/exceptions?severity=${encodeURIComponent(code)}`, depot),
      })),
      judged: judgedAtLabel(exceptions.judgedAt),
      link: { to: withDepot("/exceptions", depot), label: "See the list" },
    },
    // FR-DSH-004 is the register's count, judged today (U18).
    below: {
      value: formatCount(belowThreshold.running),
      tone: belowThreshold.running > 0 ? "critical" : "default",
      detail: `${pluralWord(belowThreshold.running, "running position", "running positions")}; ${plural(belowThreshold.spare, "spare", "spares")} disclosed separately`,
      judged: judgedAtLabel(belowThreshold.judgedAt),
      link: moneyVisible
        ? { to: withDepot("/at-risk", depot), label: "See the at-risk list" }
        : undefined,
    },
    // FR-DSH-005, 006; FR-EXC-026, 027, 029: unscheduled and unknown are
    // disclosed, never folded into the covered figure.
    units: {
      judged: judgedAtLabel(units.judgedAt),
      coverage: {
        value: `${formatCount(units.covered)} of ${formatCount(units.total)}`,
        detail: `${formatCount(units.scheduled)} scheduled, ${formatCount(units.unscheduled)} unscheduled`,
      },
      overdue: {
        value: formatCount(body.overdueTasks),
        tone: body.overdueTasks > 0 ? "warning" : "default",
      },
      stale: {
        value: formatCount(units.stale),
        detail:
          units.staleUnknown > 0
            ? `${formatCount(units.staleUnknown)} unknown, never inspected`
            : undefined,
        tone: units.stale > 0 ? "warning" : "default",
      },
      // U17: /fleet/rigs cannot narrow to a depot, so a depot view offers
      // no link to a list that counts every depot.
      rigs: {
        value: formatCount(body.pendingCompositionReports),
        tone: body.pendingCompositionReports > 0 ? "warning" : "default",
        link: depot ? undefined : { to: "/fleet/rigs", label: "See the rigs" },
      },
    },
  };
}

export interface InflationRow {
  key: string;
  band: string;
  readings: string;
  tyres: string;
  share: string;
  cold: string;
  hot: string;
  unknown: string;
}

export interface PanelsView {
  inflation: { judged: string; unavailable?: string; window?: string; rows: InflationRow[] };
  tread: { judged: string; bands: Band[] };
  forecast: { value: string; detail?: string; judged: string };
  wear: { value: string; detail?: string; judged: string; link: TileLink };
}

// U52: the window is the two dates the server chose, half-open as the API
// reads them, so the line says the end date is excluded.
function windowLine(inflation: InflationCompliance, formatDate: Formatter): string | undefined {
  if (inflation.from === null || inflation.to === null) return undefined;
  const span = `${formatDate(inflation.from)} to ${formatDate(inflation.to)}. The end date is excluded.`;
  return inflation.windowDays === null
    ? `Chosen period: ${span}`
    : `Configured window: ${plural(inflation.windowDays, "day", "days")}, ${span}`;
}

// TYRE-271: every band in words; a null share is named, never 0%.
function inflationRow(b: InflationBand): InflationRow {
  return {
    key: String(b.bandOrdinal),
    band: inflationBandLabel(b.bandKey),
    readings: formatCount(b.readingCount),
    tyres: formatCount(b.tyreCount),
    share:
      b.pctOfClassified === null ? absenceLabel("unclassifiedShare") : formatPct(b.pctOfClassified),
    cold: formatCount(b.coldCount),
    hot: formatCount(b.hotCount),
    unknown: formatCount(b.unknownCount),
  };
}

// FR-DSH-008, U40: a band is labelled from its bounds, never from
// bandLabel; the share is the wire's, rounded only by the chart.
function treadBands(distribution: TreadBand[]): Band[] {
  return distribution.map((b) => ({
    label: bandRangeLabel(b.lowerMm, b.upperExclusiveMm),
    count: b.tyreCount,
    pctOfGroup: b.pctOfGroup,
  }));
}

// dashboard.go sends a null dueCount only with its reason beside it. A null
// with no reason is a server defect, surfaced as unknown rather than given
// a code the server never defined.
function forecastValue(forecast: ForecastSummary): string {
  if (forecast.dueCount !== null) return formatCount(forecast.dueCount);
  if (forecast.unavailable === null) return absenceLabel("unknown");
  return unavailableLabel(forecast.unavailable, false);
}

// FR-DSH-016: irregularWearSummaryJSON carries no rule code, so the tile
// names the rule its count answers to, FR-EXC-035, here and nowhere else.
const IRREGULAR_WEAR_RULE = "FR-EXC-035";

export function panelsView(
  body: DashboardBody,
  depot: string | undefined,
  depotFiltered: boolean,
  formatDate: Formatter,
): PanelsView {
  const { inflationCompliance: inflation, removalForecast, irregularWear } = body;
  return {
    // U48: inflationComplianceJSON carries no judgedAt; its figures cover
    // the window or period its line names.
    inflation: {
      judged: judgedAtLabel("PERIOD"),
      unavailable: inflation.unavailable
        ? unavailableLabel(inflation.unavailable, depotFiltered)
        : undefined,
      window: inflation.unavailable ? undefined : windowLine(inflation, formatDate),
      rows: inflation.bands.map(inflationRow),
    },
    // U48: treadBandJSON carries no judgedAt; the distribution is the
    // register's current tread, so the page names today itself.
    tread: { judged: judgedAtLabel("TODAY"), bands: treadBands(body.treadDistribution) },
    // Rule 5: a null horizon or spread is a configuration absence, never a 0.
    forecast: {
      value: forecastValue(removalForecast),
      detail:
        removalForecast.horizonDays === null
          ? undefined
          : `within ${plural(removalForecast.horizonDays, "day", "days")} of ${formatDate(removalForecast.from)}`,
      judged: judgedAtLabel(removalForecast.judgedAt),
    },
    wear: {
      value:
        irregularWear.spreadWarnMm === null
          ? absenceLabel("noSpreadConfigured")
          : formatCount(irregularWear.running),
      detail:
        irregularWear.spreadWarnMm === null
          ? undefined
          : `${pluralWord(irregularWear.running, "running position", "running positions")} with a spread of ${formatMm(irregularWear.spreadWarnMm)} or more; ${plural(irregularWear.spare, "spare", "spares")} disclosed separately`,
      judged: judgedAtLabel(irregularWear.judgedAt),
      link: {
        to: withDepot(`/exceptions?rule=${IRREGULAR_WEAR_RULE}`, depot),
        label: "See the list",
      },
    },
  };
}

export interface SpareRowView {
  key: string;
  code: string;
  vehicleId: string;
  fleetNumber: string;
  position: string;
  tread: string;
  source: string;
  measured: string;
  age: string;
}

// FR-DSH-019. A spare is judged on the tenant's calendar, so it shows the
// day it was measured, not the time (FR-RPT-041); the reading's age
// (FR-TYR-017) joins the day in one cell, never a column of its own.
export function spareRows(spares: SpareRow[], formatDate: Formatter): SpareRowView[] {
  return spares.map((s) => ({
    key: s.tyreId,
    code: s.displayCode,
    vehicleId: s.vehicleId,
    fleetNumber: s.fleetNumber,
    position: s.positionCode,
    tread: s.currentTreadMm === null ? absenceLabel("unmeasured") : formatMm(s.currentTreadMm),
    source:
      s.measuredSource === null ? absenceLabel("unmeasured") : treadSourceLabel(s.measuredSource),
    measured:
      s.lastMeasuredAt === null
        ? absenceLabel("neverMeasured")
        : s.daysSinceMeasured === null
          ? formatDate(s.lastMeasuredAt)
          : `${formatDate(s.lastMeasuredAt)}, ${formatTreadAge(s.daysSinceMeasured)}`,
    age: s.ageDays === null ? absenceLabel("unknown") : formatCount(s.ageDays),
  }));
}
