import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CaptureContext, CapturePosition } from "./captureContext";
import { CaptureDiagram } from "./CaptureDiagram";
import type { RigPosition } from "./rig";
import type { Severity } from "./warnings";

const position = (
  over: Partial<CapturePosition> & { id: string; sequence: number },
): CapturePosition => ({
  vehicleId: "v-horse",
  code: String(over.sequence),
  axleClass: "STEER",
  axleType: "FIXED",
  axleNumber: 1,
  isSpare: false,
  unitLabel: null,
  tyreId: null,
  tyreCode: null,
  previousGoverningMm: null,
  previousReadingAt: null,
  fitmentSincePrevious: false,
  targetKpa: 800,
  warnUnderPct: 10,
  criticalUnderPct: 20,
  warnOverPct: 10,
  criticalOverPct: 20,
  ...over,
});

const context: CaptureContext = {
  vehicleId: "v-horse",
  fleetNumber: "BAC039SP",
  registration: null,
  unitKind: "HORSE",
  lastOdometerKm: null,
  lastOdometerAt: null,
  combination: null,
  positions: [],
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4,
  },
  cohortWearRateMmPerMonth: {},
};

// Every Severity value is represented, so a test that inspects rendered text
// cannot pass just because the offending band never appeared. See warnings.ts
// for the type — "roadworthy" included, since CR-010 governs message text,
// not this internal band identifier.
const SEVERITIES: {
  id: string;
  sequence: number;
  displayNumber: number | null;
  severity: Severity;
}[] = [
  { id: "p1", sequence: 1, displayNumber: 1, severity: "roadworthy" },
  { id: "p2", sequence: 2, displayNumber: 2, severity: "caution" },
  { id: "p3", sequence: 3, displayNumber: 3, severity: "below-removal" },
  { id: "p4", sequence: 4, displayNumber: 4, severity: "unmeasured" },
];

const rigPositions: RigPosition[] = SEVERITIES.map((s) => ({
  position: position({ id: s.id, sequence: s.sequence }),
  context,
  displayNumber: s.displayNumber,
}));

const severityById = new Map(SEVERITIES.map((s) => [s.id, s.severity]));

const props = {
  positions: rigPositions,
  severityOf: (id: string): Severity => severityById.get(id) ?? "unmeasured",
  governingOf: (id: string) => (id === "p1" ? 9 : null),
  onOpen: vi.fn(),
  activeId: null,
};

describe("CaptureDiagram", () => {
  // CR-010 / OR-LEG-001: the platform reports the tenant's configured policy
  // and never asserts roadworthiness. "roadworthy" is a legitimate internal
  // band name (warnings.ts) — this pins that it never reaches a driver,
  // including through an accessible name, where a bare {severity} would put
  // it. The fixture above covers all four Severity values, including
  // "roadworthy" itself, so this cannot pass by omission.
  it("puts no compliance language on screen or in an accessible name", () => {
    const { container } = render(<CaptureDiagram {...props} />);
    const spoken = [
      container.textContent ?? "",
      ...Array.from(container.querySelectorAll("[aria-label]")).map(
        (el) => el.getAttribute("aria-label") ?? "",
      ),
    ].join(" ");
    for (const word of ["roadworthy", "legal", "minimum"]) {
      expect(spoken.toLowerCase()).not.toContain(word);
    }
  });

  it("shows the fixed band label for every severity, never the internal name", () => {
    const { getByLabelText } = render(<CaptureDiagram {...props} />);
    expect(getByLabelText(/Position 1, BAC039SP, OK/)).toBeTruthy();
    expect(getByLabelText(/Position 2, BAC039SP, Check/)).toBeTruthy();
    expect(getByLabelText(/Position 3, BAC039SP, Report/)).toBeTruthy();
    expect(getByLabelText(/Position 4, BAC039SP, Not done/)).toBeTruthy();
  });
});
