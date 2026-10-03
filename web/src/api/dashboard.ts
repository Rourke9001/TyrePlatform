import { apiGet } from "./client";
import type { Money } from "./money";
import type { BandDatum } from "../ui/BandChart";

// Wire shapes of the B7.2 analytics routes, field for field from the Go
// structs. Money is the brand so house/money-stays-string can see every
// money field (U31, U37).

// A code is a string, not a union: the server owns the vocabulary, so an
// unknown code degrades rather than breaking on deploy order (me.ts).
export interface Scope {
  level: string;
  depotCount: number;
  depot: string | null;
}

export interface AtRiskClass {
  tyreCount: number;
  actualCount: number;
  // AUDIT nests inside this count (spec D4, U27); the hero says "of which
  // N audit" from auditCount and never subtracts.
  estimatedOrAuditCount: number;
  auditCount: number;
  unvaluedCount: number;
  casingValueAtRisk: Money | null;
}

export interface ValueAtRisk {
  judgedAt: string;
  running: AtRiskClass;
  spare: AtRiskClass;
}

// The estate's casing partitions are disjoint (U27): four counts that sum
// to tyreCount, unlike AtRiskClass's nested pair.
export interface EstateRow {
  level: string;
  keyName: string | null;
  locationClass: string;
  tyreCount: number;
  actualCount: number;
  estimatedCount: number;
  unvaluedCount: number;
  casingUnvaluedCount: number;
  casingActualCount: number;
  casingEstimatedCount: number;
  casingAuditCount: number;
  treadValue: Money | null;
  casingValue: Money | null;
  totalValue: Money | null;
}

export interface RuleCount {
  ruleCode: string;
  ruleName: string;
  severity: string;
  open: number;
  total: number;
}

export interface ExceptionSummary {
  judgedAt: string;
  open: number;
  urgent: number;
  total: number;
  bySeverity: Record<string, number>;
  byRule: RuleCount[];
  rulesConfigured: number;
}

export interface BelowThreshold {
  judgedAt: string;
  running: number;
  spare: number;
}

export interface UnitStatusSummary {
  judgedAt: string;
  total: number;
  scheduled: number;
  covered: number;
  unscheduled: number;
  stale: number;
  staleUnknown: number;
}

export interface InflationBand {
  bandOrdinal: number;
  bandKey: string;
  readingCount: number;
  tyreCount: number;
  pctOfClassified: number | null;
  coldCount: number;
  hotCount: number;
  unknownCount: number;
  totalReadings: number;
  totalTyres: number;
  unclassifiedCount: number;
}

// from and to are null only beside an unavailable reason (TENANT_ONLY,
// NO_WINDOW); a configured window always carries both (analytics.go).
export interface InflationCompliance {
  from: string | null;
  to: string | null;
  windowDays: number | null;
  unavailable: string | null;
  bands: InflationBand[];
}

// BandDatum is what the chart draws; bandLabel and keyName ride along
// unread by the chart, so the label cannot render by accident (U40).
export interface TreadBand extends BandDatum {
  keyName: string | null;
  bandLabel: string;
}

export interface ForecastSummary {
  horizonDays: number | null;
  from: string;
  unavailable: string | null;
  judgedAt: string;
  dueCount: number | null;
}

export interface IrregularWearSummary {
  judgedAt: string;
  spreadWarnMm: number | null;
  running: number;
  spare: number;
}

export interface DashboardBody {
  asAt: string;
  moneyVisible: boolean;
  scope: Scope;
  valueAtRisk: ValueAtRisk;
  estate: EstateRow;
  exceptions: ExceptionSummary;
  belowThreshold: BelowThreshold;
  units: UnitStatusSummary;
  overdueTasks: number;
  pendingCompositionReports: number;
  inflationCompliance: InflationCompliance;
  treadDistribution: TreadBand[];
  removalForecast: ForecastSummary;
  irregularWear: IrregularWearSummary;
}

export interface DashboardParams {
  depot?: string;
  from?: string;
  to?: string;
}

export interface ExceptionRow {
  ruleCode: string;
  ruleName: string;
  severity: string;
  urgent: boolean;
  subjectType: string;
  subjectId: string;
  vehicleId: string;
  fleetNumber: string;
  unitLabel: string | null;
  depotId: string | null;
  axleClass: string | null;
  positionCode: string | null;
  positionCode2: string | null;
  isSpare: boolean;
  tyreId: string | null;
  displayCode: string | null;
  inspectionId: string;
  observedAt: string;
  measureMm: number | null;
  measurePct: number | null;
  thresholdMm: number | null;
  thresholdPct: number | null;
  detail: unknown;
  resolvedByFitment: boolean;
}

export interface ExceptionsBody {
  scope: Scope;
  judgedAt: string;
  exceptions: ExceptionRow[];
}

export interface ExceptionsParams {
  depot?: string;
  severity?: string;
  rule?: string;
  vehicle?: string;
  includeResolved?: boolean;
}

export interface TyreAtRisk {
  tyreId: string;
  displayCode: string;
  vehicleId: string;
  fleetNumber: string;
  depotId: string | null;
  positionCode: string;
  isSpare: boolean;
  currentTreadMm: number;
  removalThresholdMm: number;
  treadSource: string;
  readAt: string | null;
  casingValue: Money | null;
  casingBasis: string;
}

export interface AtRiskBody {
  scope: Scope;
  judgedAt: string;
  running: AtRiskClass;
  spare: AtRiskClass;
  tyres: TyreAtRisk[];
}

export interface SpareRow {
  tyreId: string;
  displayCode: string;
  vehicleId: string;
  fleetNumber: string;
  positionCode: string;
  receivedDate: string | null;
  ageDays: number | null;
  lastMeasuredAt: string | null;
  measuredSource: string | null;
  daysSinceMeasured: number | null;
  currentTreadMm: number | null;
}

export interface SparesBody {
  scope: Scope;
  judgedAt: string;
  spares: SpareRow[];
}

// Only set parameters are sent: the API 400s on from without to, and
// refuses an empty uuid, so absence is how a request says "all" (U52).
function query(params: Record<string, string | boolean | undefined>): string {
  const pairs = Object.entries(params)
    .filter(
      (entry): entry is [string, string | true] =>
        entry[1] !== undefined && entry[1] !== false && entry[1] !== "",
    )
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === true ? "true" : v)}`);
  return pairs.length ? `?${pairs.join("&")}` : "";
}

export function fetchDashboard(params: DashboardParams): Promise<DashboardBody> {
  return apiGet<DashboardBody>(`/api/dashboard${query({ ...params })}`);
}

export function fetchExceptions(params: ExceptionsParams): Promise<ExceptionsBody> {
  return apiGet<ExceptionsBody>(`/api/exceptions${query({ ...params })}`);
}

export function fetchAtRisk(depot?: string): Promise<AtRiskBody> {
  return apiGet<AtRiskBody>(`/api/valuation/at-risk${query({ depot })}`);
}

export function fetchSpares(depot?: string): Promise<SparesBody> {
  return apiGet<SparesBody>(`/api/spares${query({ depot })}`);
}
