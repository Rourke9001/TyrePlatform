import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";

import { ActorContext } from "../auth/actorContext";
import type { Me } from "../auth/me";
import type { FitmentHistoryRow, OpenFitment, Unit, UnitPosition } from "../api/units";
import type { DashboardBody, ExceptionRow, SpareRow, TyreAtRisk } from "../api/dashboard";
import type { Money } from "../api/money";

// The default retries a failed request three times with backoff, which
// would schedule timers that outlive the test body.
export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// The one construction site for a test actor: when Me gains a field, tsc
// fails here, not silently in every test file (docs/lessons.md, 31 Aug 2026).
export function me(overrides: Partial<Me> = {}): Me {
  return {
    userId: "u0",
    displayName: "Test",
    role: "CONTROLLER",
    capabilities: [],
    depots: [],
    timezone: "Africa/Johannesburg",
    displayCodePolicy: "FREE",
    ...overrides,
  };
}

// The shared shape behind the per-screen render helpers this replaces:
// ActorContext + QueryClientProvider, with a Router only when the component
// under test needs one (TYRE-260 dedup).
export function renderWithActor(
  ui: ReactElement,
  options: {
    capabilities?: string[];
    withRouter?: boolean;
    initialEntries?: string[];
    actor?: Partial<Me>;
  } = {},
): RenderResult {
  const { capabilities = [], withRouter = false, initialEntries, actor = {} } = options;
  const content = withRouter ? createElement(MemoryRouter, { initialEntries }, ui) : ui;
  return render(
    createElement(
      ActorContext.Provider,
      { value: { actor: me({ capabilities, ...actor }), settled: true } },
      createElement(QueryClientProvider, { client: testQueryClient() }, content),
    ),
  );
}

export function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The narrowing throws rather than casts: RequestInit.body is BodyInit, and
// String() on a Blob or FormData yields "[object Object]", which would make
// a JSON assertion pass while testing nothing (docs/lessons.md, 31 Aug 2026).
export function sentBody(call: number): unknown {
  const init = vi.mocked(fetch).mock.calls[call][1];
  if (typeof init?.body !== "string") {
    throw new Error(`call ${call} did not send a string body`);
  }
  return JSON.parse(init.body);
}

// The unit surface's construction sites, for the reason me() is one: a
// field the server adds must fail tsc in one place, not pass silently in
// half a dozen (docs/lessons.md, 31 Aug 2026).
export function openFitment(overrides: Partial<OpenFitment> = {}): OpenFitment {
  return {
    fitmentId: "f1",
    tyreId: "t1",
    displayCode: "TY001",
    fittedAt: "2026-08-01T06:00:00Z",
    fittedOdometer: 100000,
    fittedTreadMm: "14.5",
    mountOrientation: "MARK_OUTBOARD",
    tyreStatus: "OK",
    retreadCount: 0,
    sizeName: "295/80R22.5",
    lastTreadMm: "12.0",
    ...overrides,
  };
}

export function unitPosition(overrides: Partial<UnitPosition> & { id: string }): UnitPosition {
  return {
    code: "POS1",
    sequence: 1,
    axleNumber: 1,
    axleClass: "STEER",
    side: "LEFT",
    slot: "SINGLE",
    isSpare: false,
    fitment: null,
    ...overrides,
  };
}

export function unit(overrides: Partial<Unit> = {}): Unit {
  return {
    id: "u1",
    fleetNumber: "HORSE-1",
    registration: "SBX001GP",
    description: null,
    bodyType: null,
    unitDescriptor: null,
    unitKind: "HORSE",
    status: "ACTIVE",
    configurationId: "c1",
    configurationName: "6x4 horse",
    homeDepotId: null,
    operatingGroupId: null,
    tags: [],
    hasHistory: false,
    removalReasons: ["Worn out", "Damaged"],
    hasOdometer: true,
    positions: [],
    ...overrides,
  };
}

export function fitmentRow(
  overrides: Partial<FitmentHistoryRow> & { fitmentId: string },
): FitmentHistoryRow {
  return {
    tyreId: "t1",
    displayCode: "TY001",
    positionCode: "POS1",
    fittedAt: "2026-08-01T06:00:00Z",
    removedAt: "2026-08-20T06:00:00Z",
    fittedOdometer: 100000,
    removedOdometer: 112000,
    fittedTreadMm: "14.5",
    removedTreadMm: "9.0",
    removalReason: "Worn out",
    distanceKm: 12000,
    distanceSource: "MEASURED",
    mountOrientation: "MARK_OUTBOARD",
    ...overrides,
  };
}

// fetch takes RequestInfo | URL; String() on a Request/URL yields text a
// path assertion could match by accident, so the shape is checked, not
// coerced (docs/lessons.md, 31 Aug 2026).
export function requestedUrl(input: RequestInfo | URL): string {
  if (typeof input !== "string") {
    throw new Error("fetch was called with something other than a path string");
  }
  return input;
}

// The dashboard's one construction site (docs/lessons.md, 31 Aug 2026).
// Every default is the BAC fixture's own answer, the figures
// dashboard_test.go pins, so a test that passes here passes on the wire's
// shape.
export function dashboardBody(overrides: Partial<DashboardBody> = {}): DashboardBody {
  return {
    asAt: "2026-09-22T07:10:45.563568Z",
    moneyVisible: true,
    scope: { level: "TENANT", depotCount: 0, depot: null },
    valueAtRisk: {
      judgedAt: "TODAY",
      running: {
        tyreCount: 9,
        actualCount: 0,
        estimatedOrAuditCount: 9,
        auditCount: 9,
        unvaluedCount: 0,
        casingValueAtRisk: "16537.50" as Money,
      },
      spare: {
        tyreCount: 1,
        actualCount: 0,
        estimatedOrAuditCount: 1,
        auditCount: 1,
        unvaluedCount: 0,
        casingValueAtRisk: "1837.50" as Money,
      },
    },
    estate: {
      level: "TENANT",
      keyName: null,
      locationClass: "ALL",
      tyreCount: 27,
      actualCount: 27,
      estimatedCount: 0,
      unvaluedCount: 0,
      casingUnvaluedCount: 0,
      casingActualCount: 0,
      casingEstimatedCount: 0,
      casingAuditCount: 27,
      treadValue: "20571.00" as Money,
      casingValue: "49612.50" as Money,
      totalValue: "70183.50" as Money,
    },
    exceptions: {
      judgedAt: "SUBMITTED_AT",
      open: 19,
      urgent: 11,
      total: 19,
      bySeverity: { CRITICAL: 11, WARNING: 8 },
      byRule: [
        {
          ruleCode: "FR-EXC-021",
          ruleName: "Tread approaching threshold",
          severity: "WARNING",
          open: 1,
          total: 1,
        },
        {
          ruleCode: "FR-EXC-035",
          ruleName: "Irregular wear across the tread",
          severity: "WARNING",
          open: 6,
          total: 6,
        },
        {
          ruleCode: "FR-EXC-036",
          ruleName: "Dual-mate mismatch",
          severity: "WARNING",
          open: 1,
          total: 1,
        },
        {
          ruleCode: "FR-EXC-020",
          ruleName: "Tread below removal threshold",
          severity: "CRITICAL",
          open: 9,
          total: 9,
        },
        {
          ruleCode: "FR-EXC-022",
          ruleName: "Pressure dangerously under",
          severity: "CRITICAL",
          open: 1,
          total: 1,
        },
        {
          ruleCode: "FR-EXC-038",
          ruleName: "Spare below removal threshold",
          severity: "CRITICAL",
          open: 1,
          total: 1,
        },
      ],
      rulesConfigured: 9,
    },
    belowThreshold: { judgedAt: "TODAY", running: 9, spare: 1 },
    units: {
      judgedAt: "TENANT_TODAY",
      total: 3,
      scheduled: 0,
      covered: 0,
      unscheduled: 3,
      stale: 3,
      staleUnknown: 0,
    },
    overdueTasks: 0,
    pendingCompositionReports: 0,
    inflationCompliance: {
      from: "2026-08-24",
      to: "2026-09-23",
      windowDays: 30,
      unavailable: null,
      bands: [
        {
          bandOrdinal: 1,
          bandKey: "dangerously_under",
          readingCount: 0,
          tyreCount: 0,
          pctOfClassified: null,
          coldCount: 0,
          hotCount: 0,
          unknownCount: 0,
          totalReadings: 0,
          totalTyres: 0,
          unclassifiedCount: 0,
        },
        {
          bandOrdinal: 2,
          bandKey: "under",
          readingCount: 0,
          tyreCount: 0,
          pctOfClassified: null,
          coldCount: 0,
          hotCount: 0,
          unknownCount: 0,
          totalReadings: 0,
          totalTyres: 0,
          unclassifiedCount: 0,
        },
        {
          bandOrdinal: 3,
          bandKey: "correct",
          readingCount: 0,
          tyreCount: 0,
          pctOfClassified: null,
          coldCount: 0,
          hotCount: 0,
          unknownCount: 0,
          totalReadings: 0,
          totalTyres: 0,
          unclassifiedCount: 0,
        },
        {
          bandOrdinal: 4,
          bandKey: "over",
          readingCount: 0,
          tyreCount: 0,
          pctOfClassified: null,
          coldCount: 0,
          hotCount: 0,
          unknownCount: 0,
          totalReadings: 0,
          totalTyres: 0,
          unclassifiedCount: 0,
        },
        {
          bandOrdinal: 5,
          bandKey: "dangerously_over",
          readingCount: 0,
          tyreCount: 0,
          pctOfClassified: null,
          coldCount: 0,
          hotCount: 0,
          unknownCount: 0,
          totalReadings: 0,
          totalTyres: 0,
          unclassifiedCount: 0,
        },
      ],
    },
    treadDistribution: [
      {
        keyName: null,
        bandOrdinal: 1,
        bandLabel: "0-4mm",
        lowerMm: 0,
        upperExclusiveMm: 5,
        tyreCount: 10,
        pctOfGroup: 37.04,
      },
      {
        keyName: null,
        bandOrdinal: 2,
        bandLabel: "5-7mm",
        lowerMm: 5,
        upperExclusiveMm: 8,
        tyreCount: 6,
        pctOfGroup: 22.22,
      },
      {
        keyName: null,
        bandOrdinal: 3,
        bandLabel: "8-10mm",
        lowerMm: 8,
        upperExclusiveMm: 11,
        tyreCount: 2,
        pctOfGroup: 7.41,
      },
      {
        keyName: null,
        bandOrdinal: 4,
        bandLabel: "11-13mm",
        lowerMm: 11,
        upperExclusiveMm: 14,
        tyreCount: 7,
        pctOfGroup: 25.93,
      },
      {
        keyName: null,
        bandOrdinal: 5,
        bandLabel: "14mm+",
        lowerMm: 14,
        upperExclusiveMm: null,
        tyreCount: 2,
        pctOfGroup: 7.41,
      },
    ],
    removalForecast: {
      horizonDays: 30,
      from: "2026-09-22",
      unavailable: null,
      judgedAt: "TODAY",
      dueCount: 10,
    },
    irregularWear: { judgedAt: "LATEST_READING", spreadWarnMm: 4, running: 5, spare: 1 },
    ...overrides,
  };
}

export function exceptionRow(
  overrides: Partial<ExceptionRow> & { subjectId: string },
): ExceptionRow {
  return {
    ruleCode: "FR-EXC-020",
    ruleName: "Tread below removal threshold",
    severity: "CRITICAL",
    urgent: true,
    subjectType: "TYRE",
    vehicleId: "v1",
    fleetNumber: "HORSE",
    unitLabel: "Truck tractor 6x4",
    // The BAC response's exception rows all carry a depot (ruling B1).
    depotId: "d1",
    axleClass: "DRIVE",
    positionCode: "7",
    positionCode2: null,
    isSpare: false,
    tyreId: "t1",
    displayCode: "2102BAC7",
    inspectionId: "i1",
    observedAt: "2026-07-23T05:46:30Z",
    measureMm: 1,
    measurePct: null,
    thresholdMm: 4,
    thresholdPct: null,
    detail: {},
    resolvedByFitment: false,
    ...overrides,
  };
}

// The at-risk list's own capture: every BAC tyre on it carries a reading
// (not an audit) source and a depot (ruling B1; the exceptions capture's
// BAC tyre has neither).
export function atRiskTyre(overrides: Partial<TyreAtRisk> & { tyreId: string }): TyreAtRisk {
  return {
    displayCode: "2102BAC7",
    vehicleId: "v1",
    fleetNumber: "HORSE",
    depotId: "d1",
    positionCode: "7",
    isSpare: false,
    currentTreadMm: 1,
    removalThresholdMm: 4,
    treadSource: "READING",
    readAt: "2026-07-23T05:46:30Z",
    casingValue: "1837.50" as Money,
    casingBasis: "AUDIT",
    ...overrides,
  };
}

export function spareRow(overrides: Partial<SpareRow> & { tyreId: string }): SpareRow {
  return {
    displayCode: "2102BACS",
    vehicleId: "v12",
    fleetNumber: "LINK12",
    positionCode: "S",
    receivedDate: "2024-03-01",
    ageDays: 935,
    lastMeasuredAt: "2026-07-23T05:46:30Z",
    measuredSource: "READING",
    daysSinceMeasured: 61,
    currentTreadMm: 2,
    ...overrides,
  };
}
