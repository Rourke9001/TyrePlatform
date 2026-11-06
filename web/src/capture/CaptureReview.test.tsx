import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { expectNothingForbiddenSpoken } from "../test/spoken";
import type { CaptureContext, CapturePosition } from "./captureContext";
import { CaptureReview } from "./CaptureReview";
import type { Draft, DraftPosition } from "./draft";
import { cellKey } from "./draft";
import type { WarningCode } from "./warnings";

function spare(vehicleId: string): CapturePosition {
  return {
    id: "spare",
    vehicleId,
    code: "S1",
    sequence: 90,
    axleClass: "SPARE",
    axleType: "FIXED",
    side: null,
    axleNumber: null,
    isSpare: true,
    unitLabel: null,
    tyreId: null,
    tyreCode: null,
    previousGoverningMm: null,
    previousReadingAt: null,
    fitmentSincePrevious: false,
    // FR-CFG-013 as amended: a spare has no target, so nothing here bands its
    // pressure. The flags under test come from the treads.
    targetKpa: null,
    warnUnderPct: null,
    criticalUnderPct: null,
    warnOverPct: null,
    criticalOverPct: null,
  };
}

// Two links of one superlink share the position id (app.position belongs
// to an axle configuration, not a vehicle), so a bare "Spare" is ambiguous
// (draft.cellKey).
function unit(vehicleId: string, fleetNumber: string): CaptureContext {
  return {
    vehicleId,
    fleetNumber,
    registration: null,
    unitKind: "TRAILER",
    lastOdometerKm: null,
    lastOdometerAt: null,
    averageDailyKm: null,
    positions: [spare(vehicleId)],
    combination: null,
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
}

function flaggedSpare(vehicleId: string): DraftPosition {
  return {
    positionId: "spare",
    vehicleId,
    tyreId: null,
    treads: [3, 3, 3],
    pressureKpa: null,
    pressureTemperature: "UNKNOWN",
    damageFlag: false,
    note: null,
    seconds: 20,
    warnings: [{ code: "FR-INS-036", enteredValue: "3", response: "ACKNOWLEDGED" }],
  };
}

describe("CaptureReview", () => {
  // Every configuration carries a spare count, so a rig has one spare per
  // unit (BR-VEH-003); a spare has no walk-around number, so the owning
  // unit is the only thing that tells them apart.
  it("names the unit a flagged spare belongs to", () => {
    const contexts = [unit("v1", "BAC039SP"), unit("v2", "LINK6")];
    const positions = {
      [cellKey("v1", "spare")]: flaggedSpare("v1"),
      [cellKey("v2", "spare")]: flaggedSpare("v2"),
    };
    const draft: Draft = {
      clientUuid: "c1",
      vehicleId: "v1",
      fleetNumber: "BAC039SP",
      combinationId: "comb1",
      observedMemberVehicleIds: ["v1", "v2"],
      taskId: null,
      startedAt: new Date().toISOString(),
      odometerKm: null,
      comment: null,
      defectReport: null,
      positions,
      warnings: [],
      absentSpares: [],
      driverSubject: "oid-driver-1",
      legacy: false,
    };

    render(
      <CaptureReview
        contexts={contexts}
        draft={draft}
        doneCells={new Set(Object.keys(positions))}
        absentCells={new Set()}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    const rows = screen.getAllByText(/^Spare, /);
    expect(rows.map((r) => r.textContent)).toEqual(["Spare, BAC039SP", "Spare, LINK6"]);
  });

  // CR-010/OR-LEG-001 (TYRE-207): every name the review gives a flag is
  // swept, so each warning code is raised once.
  it("names everything it found without a forbidden word", () => {
    const codes: WarningCode[] = [
      "FR-INS-031a",
      "FR-INS-034",
      "FR-INS-035",
      "FR-INS-036",
      "FR-INS-037",
      "FR-INS-041",
    ];
    const flagged: DraftPosition = {
      ...flaggedSpare("v1"),
      warnings: codes.map((code) => ({ code, enteredValue: "3", response: "ACKNOWLEDGED" })),
    };
    const draft: Draft = {
      clientUuid: "c1",
      vehicleId: "v1",
      fleetNumber: "BAC039SP",
      combinationId: null,
      observedMemberVehicleIds: ["v1"],
      taskId: null,
      startedAt: new Date().toISOString(),
      odometerKm: 999999,
      comment: null,
      defectReport: null,
      positions: { [cellKey("v1", "spare")]: flagged },
      warnings: [{ code: "FR-INS-033", enteredValue: "999999", response: "CONFIRMED" }],
      absentSpares: [],
      driverSubject: "oid-driver-1",
      legacy: false,
    };

    const { container } = render(
      <CaptureReview
        contexts={[unit("v1", "BAC039SP")]}
        draft={draft}
        doneCells={new Set([cellKey("v1", "spare")])}
        absentCells={new Set()}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    expect(container.querySelectorAll("[data-warning-code]")).toHaveLength(7);
    expectNothingForbiddenSpoken(container, /replacement point/);
  });

  // U55 (TYRE-342): the figure beside a flag groups as the sheet's warning
  // and the odometer readout do.
  it("groups the figure each flag carries", () => {
    const flagged: DraftPosition = {
      ...flaggedSpare("v1"),
      warnings: [
        { code: "FR-INS-031a", enteredValue: "1100", response: "CONFIRMED" },
        // groupThousands takes whole digits, so a fraction passes through as
        // stored, here as a draft on the phone may hold one.
        { code: "FR-INS-041", enteredValue: "3.3000000000000007", response: "ACKNOWLEDGED" },
      ],
    };
    const draft: Draft = {
      clientUuid: "c1",
      vehicleId: "v1",
      fleetNumber: "BAC039SP",
      combinationId: null,
      observedMemberVehicleIds: ["v1"],
      taskId: null,
      startedAt: new Date().toISOString(),
      odometerKm: 999999,
      comment: null,
      defectReport: null,
      positions: { [cellKey("v1", "spare")]: flagged },
      warnings: [{ code: "FR-INS-033", enteredValue: "999999", response: "CONFIRMED" }],
      absentSpares: [],
      driverSubject: "oid-driver-1",
      legacy: false,
    };

    const { container } = render(
      <CaptureReview
        contexts={[unit("v1", "BAC039SP")]}
        draft={draft}
        doneCells={new Set([cellKey("v1", "spare")])}
        absentCells={new Set()}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    const figure = (code: string) =>
      container.querySelector(`[data-warning-code="${code}"] .cap-flag-val`)?.textContent;
    expect(figure("FR-INS-031a")).toBe("1,100");
    expect(figure("FR-INS-041")).toBe("3.3000000000000007");
    expect(figure("FR-INS-033")).toBe("999,999");
  });
});

// TYRE-171: a draft held on the phone can be resumed days later (ADR-0009),
// so the elapsed time reads in hours from the first hour on, never as a
// count of thousands of minutes.
describe("CaptureReview's elapsed time", () => {
  const NOW = new Date("2026-08-27T06:00:00Z");

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function subtitleAfter(seconds: number): string | null {
    render(
      <CaptureReview
        contexts={[unit("v1", "BAC039SP")]}
        draft={{
          clientUuid: "c1",
          vehicleId: "v1",
          fleetNumber: "BAC039SP",
          combinationId: null,
          observedMemberVehicleIds: ["v1"],
          taskId: null,
          startedAt: new Date(NOW.getTime() - seconds * 1000).toISOString(),
          odometerKm: null,
          comment: null,
          defectReport: null,
          positions: {},
          warnings: [],
          absentSpares: [],
          driverSubject: "oid-driver-1",
          legacy: false,
        }}
        doneCells={new Set()}
        absentCells={new Set()}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    return screen.getByText(/positions done/).textContent;
  }

  it.each([
    [42, "42 sec"],
    [59 * 60 + 59, "59 min 59 sec"],
    [60 * 60, "1 hr 0 min"],
    [3 * 3600 + 12 * 60 + 30, "3 hr 12 min"],
    [3 * 86_400, "72 hr 0 min"],
    [1000 * 3600, "1,000 hr 0 min"],
  ])("reads %i seconds as %s", (seconds, words) => {
    expect(subtitleAfter(seconds)).toBe(`0 of 1 positions done · ${words}`);
  });
});
