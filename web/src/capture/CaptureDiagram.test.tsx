import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CaptureContext, CapturePosition } from "./captureContext";
import { expectNothingForbiddenSpoken } from "../test/spoken";
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
  side: "LEFT",
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
  averageDailyKm: null,
  combination: null,
  positions: [],
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4,
    captureSpares: true,
  },
  cohortWearRateMmPerMonth: {},
};

// Every Severity value is represented so this cannot pass by omission.
// "roadworthy" is included: CR-010 governs message text, not this internal
// band identifier (warnings.ts).
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
  absentCells: new Set<string>(),
};

describe("CaptureDiagram", () => {
  // CR-010/OR-LEG-001: the platform reports configured policy, never
  // asserts roadworthiness. Pins that "roadworthy" (a legitimate internal
  // band name, warnings.ts) never reaches a driver, including via
  // accessible name.
  it("puts no compliance language on screen or in an accessible name", () => {
    const { container } = render(<CaptureDiagram {...props} />);
    expectNothingForbiddenSpoken(container, /position 1/);
  });

  it("shows the fixed band label for every severity, never the internal name", () => {
    const { getByLabelText } = render(<CaptureDiagram {...props} />);
    expect(getByLabelText(/Position 1, BAC039SP, OK/)).toBeTruthy();
    expect(getByLabelText(/Position 2, BAC039SP, Check/)).toBeTruthy();
    expect(getByLabelText(/Position 3, BAC039SP, Report/)).toBeTruthy();
    expect(getByLabelText(/Position 4, BAC039SP, Not done/)).toBeTruthy();
  });

  // AxleDiagram splits an axle by side only when every tile has one. The
  // sides here would put p1 and p2 left under a count split, so seeing p2
  // and p3 left proves the wire's side was passed.
  it("draws each tile on its wire side, and falls back to the count split without sides", () => {
    const withSides = (sides: CapturePosition["side"][]) =>
      rigPositions.map((r, i) => ({ ...r, position: { ...r.position, side: sides[i] } }));
    const leftIds = (positions: RigPosition[]) => {
      const { container } = render(<CaptureDiagram {...props} positions={positions} />);
      return [
        ...container.querySelectorAll<HTMLElement>(".tr-axle__side--left [data-position-id]"),
      ].map((el) => el.dataset.positionId);
    };

    expect(leftIds(withSides(["RIGHT", "LEFT", "LEFT", "RIGHT"]))).toEqual(["p2", "p3"]);
    expect(leftIds(withSides([null, null, null, null]))).toEqual(["p1", "p2"]);
  });

  // TYRE-155: an absent cell is settled, not unmeasured. The severity was
  // computed off nothing entered, so "Not done" would contradict the "done"
  // the header and tally already count it as.
  it("reads 'No spare', not the severity band, on a cell marked absent", () => {
    const cell = cellKey(context.vehicleId, "p4");
    const { container, getByLabelText } = render(
      <CaptureDiagram {...props} absentCells={new Set([cell])} />,
    );
    const el = container.querySelector<HTMLElement>(`[data-position-id="p4"]`);
    expect(el).toHaveClass("tr-tile--neutral");
    expect(el).toHaveTextContent("No spare");
    expect(el).toHaveTextContent("none");
    expect(getByLabelText(/Position 4, BAC039SP, no spare/)).toBeTruthy();
    expect(el?.getAttribute("aria-label")).not.toContain("Not done");
  });
});

// Two units of two axles plus a spare: the minimum shape that catches a
// unit-band emitted per axle instead of per unit, and where position ids
// differ across units so a querySelector's first match cannot mask
// cross-wiring. groupRig keys on (vehicleId, axleNumber), so id sharing
// cannot affect it.
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
    side: d.isSpare ? null : "LEFT",
  }),
  key: cellKey(d.context.vehicleId, d.id),
  context: d.context,
  displayNumber: d.displayNumber,
}));

// p1 carries a governing reading, everything else does not. The two
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
      absentCells={new Set()}
    />,
  );
}

describe("CaptureDiagram with multiple units", () => {
  it("labels the unit band once per unit, not once per axle", () => {
    const { container } = renderDedup(vi.fn());
    const bands = Array.from(container.querySelectorAll(".tr-unit__head")).map(
      (el) => el.textContent,
    );
    expect(bands).toEqual(["BAC039SP", "BAC040SP", "BAC039SP spare"]);
  });

  // These do not discriminate the per-axle band bug (see the test above for
  // that). They pin the coupling mark and the spares branch instead
  // (FR-INS-060/FR-INS-061, the requirements CouplingMark cites).
  it("draws one coupling mark, one axle row per axle group, and the spare row once", () => {
    const { container } = renderDedup(vi.fn());
    expect(container.querySelectorAll(".tr-unit")).toHaveLength(3);
    expect(container.querySelectorAll(".tr-axles__hitch")).toHaveLength(1);
    expect(container.querySelectorAll(".tr-axle, .tr-spares")).toHaveLength(5);
    expect(container.querySelectorAll(".tr-spares")).toHaveLength(1);
  });

  it("renders the governing reading where one exists and a dash where it does not", () => {
    const { container } = renderDedup(vi.fn());
    expect(container.querySelector('[data-position-id="p1"] .tr-tile__val')?.textContent).toBe(
      "9mm",
    );
    expect(container.querySelector('[data-position-id="p2"] .tr-tile__val')?.textContent).toBe("—");
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

// Pins: two trailers on one axle CONFIGURATION share app.position.unit_label
// ("2-axle trailer"); only CaptureContext.fleetNumber distinguishes them
// (BR-VEH-003).
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
        absentCells={new Set()}
      />,
    );
    const bands = Array.from(container.querySelectorAll(".tr-unit__head")).map(
      (el) => el.textContent,
    );
    expect(bands).toHaveLength(2);
    // Both units share the configuration label, so a heading merely
    // containing "2-axle trailer" would pass even with the bug live;
    // asserting the headings differ and each carries its own fleet number
    // is what catches it.
    expect(bands[0]).not.toBe(bands[1]);
    expect(bands[0]).toContain("LINK6");
    expect(bands[1]).toContain("LINK12");
  });
});

// Every axle configuration carries a spare count, so an ordinary superlink
// has one spare per unit; drawn in one band they are identical S cells with
// nothing to tell them apart after entry (BR-VEH-003).
const sameConfigSpares: RigPosition[] = [link6, link12].map((unit) => ({
  position: position({
    id: "s1",
    vehicleId: unit.vehicleId,
    sequence: 99,
    axleNumber: null,
    isSpare: true,
    axleClass: "SPARE",
    side: null,
    unitLabel: "2-axle trailer",
  }),
  key: cellKey(unit.vehicleId, "s1"),
  context: unit,
  displayNumber: null,
}));

describe("CaptureDiagram with a spare on each unit", () => {
  it("gives each unit's spare its own identity beside the cell", () => {
    const { container } = render(
      <CaptureDiagram
        positions={sameConfigSpares}
        severityOf={() => "unmeasured"}
        governingOf={() => null}
        onOpen={vi.fn()}
        activeKey={null}
        absentCells={new Set()}
      />,
    );

    // Asserted on the band next to each cell, not the cell count: two
    // spares under one heading satisfy "two spare cells exist" too, which
    // is how the defect survived.
    const rows = Array.from(container.querySelectorAll(".tr-unit")).filter((u) =>
      u.querySelector(".tr-spares"),
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((u) => u.querySelector(".tr-unit__head")?.textContent)).toEqual([
      "LINK6 spare",
      "LINK12 spare",
    ]);
    expect(
      rows.map((u) => u.querySelector("[data-position-id]")?.getAttribute("aria-label")),
    ).toEqual(["Spare, LINK6, Not done", "Spare, LINK12, Not done"]);
  });
});

// FR-INS-060, FR-VEH-034 (U156): a tile shows the rig-wide number, so its
// name carries the per-unit place in words, from the wire's axle and side
// alone. A spare has neither and keeps the name it has.
const placed: RigPosition[] = [
  { id: "p3", sequence: 3, axleNumber: 2, side: "LEFT" as const, displayNumber: 3 },
  { id: "p4", sequence: 4, axleNumber: 2, side: "RIGHT" as const, displayNumber: 4 },
  { id: "ps", sequence: 99, axleNumber: null, side: null, displayNumber: null },
].map((p) => ({
  position: position({
    id: p.id,
    sequence: p.sequence,
    axleNumber: p.axleNumber,
    side: p.side,
    isSpare: p.displayNumber === null,
  }),
  key: cellKey(context.vehicleId, p.id),
  context,
  displayNumber: p.displayNumber,
}));

describe("CaptureDiagram's place words", () => {
  it("names a running tile's axle and side, and leaves a spare's name as it is", () => {
    const { getByRole } = render(
      <CaptureDiagram
        positions={placed}
        severityOf={() => "unmeasured"}
        governingOf={() => null}
        onOpen={vi.fn()}
        activeKey={null}
        absentCells={new Set()}
      />,
    );
    expect(
      getByRole("button", { name: "Position 3, BAC039SP, Not done, axle 2, left" }),
    ).toBeInTheDocument();
    expect(
      getByRole("button", { name: "Position 4, BAC039SP, Not done, axle 2, right" }),
    ).toBeInTheDocument();
    expect(getByRole("button", { name: "Spare, BAC039SP, Not done" })).toBeInTheDocument();
  });
});
