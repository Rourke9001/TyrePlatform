import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CaptureContext, CapturePosition } from "./captureContext";
import { CaptureDiagram } from "./CaptureDiagram";
import { cellKey } from "./draft";
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
  key: cellKey(context.vehicleId, s.id),
  context,
  displayNumber: s.displayNumber,
}));

// Keyed by cell, like everything the diagram hands back: a position id alone
// names two wheels on a rig of same-configuration units (draft.cellKey).
const severityByCell = new Map(
  SEVERITIES.map((s) => [cellKey(context.vehicleId, s.id), s.severity]),
);

const props = {
  positions: rigPositions,
  severityOf: (cell: string): Severity => severityByCell.get(cell) ?? "unmeasured",
  governingOf: (cell: string) => (cell === cellKey(context.vehicleId, "p1") ? 9 : null),
  onOpen: vi.fn(),
  activeKey: null,
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

// Two units of two axles each, plus a spare. The fixture above puts every
// position on one vehicleId and one axleNumber, so groupRig only ever builds
// one axle group — a unit-band emitted per axle rather than per unit renders
// identically under it. This fixture has four axle groups across two units,
// which is the minimum shape that tells the two apart. Each unit carries its
// own context (own fleetNumber) rather than sharing one: groupRig labels a
// unit from position.unitLabel ?? context.fleetNumber, so a shared context
// would print unit B's band as unit A's fleet number and hide cross-wiring.
//
// Distinct position ids across the two units here, unlike the flow fixture: the
// assertions below address cells through data-position-id with querySelector,
// which answers with the first match. Real units of one axle configuration do
// share ids, and under that shape those two assertions would silently be about
// unit A's cell while reading as though they covered the rendering generally.
// Nothing is lost by keeping them apart — groupRig keys on (vehicleId,
// axleNumber), so id sharing cannot affect the grouping this block exists for.
const unitA: CaptureContext = { ...context, vehicleId: "v-horse", fleetNumber: "BAC039SP" };
const unitB: CaptureContext = { ...context, vehicleId: "v-link", fleetNumber: "BAC040SP" };

const DEDUP: {
  id: string;
  context: CaptureContext;
  sequence: number;
  axleNumber: number | null;
  displayNumber: number | null;
  isSpare?: boolean;
}[] = [
  { id: "p1", context: unitA, sequence: 1, axleNumber: 1, displayNumber: 1 },
  { id: "p2", context: unitA, sequence: 2, axleNumber: 1, displayNumber: 2 },
  { id: "p3", context: unitA, sequence: 3, axleNumber: 2, displayNumber: 3 },
  { id: "p4", context: unitA, sequence: 4, axleNumber: 2, displayNumber: 4 },
  { id: "ps", context: unitA, sequence: 99, axleNumber: null, displayNumber: null, isSpare: true },
  { id: "p5", context: unitB, sequence: 1, axleNumber: 1, displayNumber: 5 },
  { id: "p6", context: unitB, sequence: 2, axleNumber: 1, displayNumber: 6 },
  { id: "p7", context: unitB, sequence: 3, axleNumber: 2, displayNumber: 7 },
  { id: "p8", context: unitB, sequence: 4, axleNumber: 2, displayNumber: 8 },
];

const dedupPositions: RigPosition[] = DEDUP.map((d) => ({
  position: position({
    id: d.id,
    vehicleId: d.context.vehicleId,
    sequence: d.sequence,
    axleNumber: d.axleNumber,
    isSpare: d.isSpare ?? false,
  }),
  key: cellKey(d.context.vehicleId, d.id),
  context: d.context,
  displayNumber: d.displayNumber,
}));

// p1 carries a governing reading, everything else does not — the two
// outcomes of PositionCell's governing display each get one representative.
const dedupGoverningOf = (cell: string) => (cell === cellKey(unitA.vehicleId, "p1") ? 9 : null);
const dedupSeverityOf = (cell: string) =>
  cell === cellKey(unitA.vehicleId, "p1") ? "roadworthy" : "unmeasured";

// A fresh onOpen per render: the module-level props.onOpen above is shared
// across the first describe block's tests and would accumulate calls if
// reused here, making a toHaveBeenCalledTimes assertion depend on test order.
function renderDedup(onOpen: (cell: string) => void) {
  return render(
    <CaptureDiagram
      positions={dedupPositions}
      severityOf={dedupSeverityOf}
      governingOf={dedupGoverningOf}
      onOpen={onOpen}
      activeKey={null}
    />,
  );
}

describe("CaptureDiagram with multiple units", () => {
  it("labels the unit band once per unit, not once per axle", () => {
    const { container } = renderDedup(vi.fn());
    const bands = Array.from(container.querySelectorAll(".cap-unitband")).map(
      (el) => el.textContent,
    );
    expect(bands).toEqual(["BAC039SP", "BAC040SP", "Spare"]);
  });

  // These do not discriminate the per-axle band bug (see the test above for
  // that) — they pin the coupling mark and the spares branch instead
  // (FR-INS-060/FR-INS-061, the requirements CouplingMark cites).
  it("draws one coupling mark, one axle row per axle group, and the spare row once", () => {
    const { container } = renderDedup(vi.fn());
    expect(container.querySelectorAll(".cap-unit")).toHaveLength(3);
    expect(container.querySelectorAll(".cap-coupling")).toHaveLength(1);
    expect(container.querySelectorAll(".cap-axle")).toHaveLength(5);
    expect(container.querySelectorAll(".cap-axle--spare")).toHaveLength(1);
  });

  it("renders the governing reading where one exists and a dash where it does not", () => {
    const { container } = renderDedup(vi.fn());
    expect(container.querySelector('[data-position-id="p1"] .cap-pos-v')?.textContent).toBe("9mm");
    expect(container.querySelector('[data-position-id="p2"] .cap-pos-v')?.textContent).toBe("—");
  });

  it("opens the tapped position in the second unit, proving onOpen survives the grouping", () => {
    const onOpen = vi.fn();
    const { getByLabelText } = renderDedup(onOpen);
    fireEvent.click(getByLabelText(/^Position 7, BAC040SP,/));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(cellKey(unitB.vehicleId, "p7"));
  });

  it("opens a spare through its own render path", () => {
    const onOpen = vi.fn();
    const { getByLabelText } = renderDedup(onOpen);
    fireEvent.click(getByLabelText(/^Spare, BAC039SP,/));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(cellKey(unitA.vehicleId, "ps"));
  });
});

// The defect this pins: two member trailers of one ordinary superlink are
// built from the identical axle CONFIGURATION, so app.position.unit_label
// ("2-axle trailer" for TRAILER_2AXLE) is the same string for both. A band
// that showed only that label would render "2-AXLE TRAILER" twice with
// nothing to tell a driver which section belongs to which unit
// (BR-VEH-003). Only app.vehicle — CaptureContext.fleetNumber — actually
// distinguishes them.
const link6: CaptureContext = { ...context, vehicleId: "v-link6", fleetNumber: "LINK6" };
const link12: CaptureContext = { ...context, vehicleId: "v-link12", fleetNumber: "LINK12" };

const sameConfigPositions: RigPosition[] = [
  {
    position: position({
      id: "l6-1",
      vehicleId: link6.vehicleId,
      sequence: 1,
      unitLabel: "2-axle trailer",
    }),
    key: cellKey(link6.vehicleId, "l6-1"),
    context: link6,
    displayNumber: 1,
  },
  {
    position: position({
      id: "l12-1",
      vehicleId: link12.vehicleId,
      sequence: 1,
      unitLabel: "2-axle trailer",
    }),
    key: cellKey(link12.vehicleId, "l12-1"),
    context: link12,
    displayNumber: 2,
  },
];

describe("CaptureDiagram with two units of the same configuration", () => {
  it("names each unit's own heading rather than repeating the shared configuration label", () => {
    const { container } = render(
      <CaptureDiagram
        positions={sameConfigPositions}
        severityOf={() => "unmeasured"}
        governingOf={() => null}
        onOpen={vi.fn()}
        activeKey={null}
      />,
    );
    const bands = Array.from(container.querySelectorAll(".cap-unitband")).map(
      (el) => el.textContent,
    );
    expect(bands).toHaveLength(2);
    // Both units carry the identical configuration label, so a heading that
    // merely CONTAINS "2-axle trailer" would pass on both sections even with
    // the pre-fix bug live. Asserting the two headings differ, and that each
    // carries its own fleet number, is what actually catches it.
    expect(bands[0]).not.toBe(bands[1]);
    expect(bands[0]).toContain("LINK6");
    expect(bands[1]).toContain("LINK12");
  });
});
