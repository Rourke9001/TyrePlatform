import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import type { CaptureContext, CapturePosition } from "./captureContext";
import { CaptureReview } from "./CaptureReview";
import type { Draft, DraftPosition } from "./draft";
import { cellKey } from "./draft";

function spare(vehicleId: string): CapturePosition {
  return {
    id: "spare",
    vehicleId,
    code: "S1",
    sequence: 90,
    axleClass: "SPARE",
    axleType: "FIXED",
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

// Two links of one superlink: the ordinary rig, and the one where a bare
// "Spare" is ambiguous. They share the position id because app.position rows
// belong to an axle configuration rather than to a vehicle (draft.cellKey).
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
  // The decision-before-submit moment, so a row that cannot be traced back to
  // a wheel is worse here than anywhere else. Every configuration in the
  // register carries a spare count, so a rig has one spare per unit
  // (BR-VEH-003) and a spare has no walk-around number to tell them apart —
  // the unit that owns it is the only thing that does.
  it("names the unit a flagged spare belongs to", () => {
    const contexts = [unit("v1", "BAC039SP"), unit("v2", "LINK6")];
    const positions = {
      [cellKey("v1", "spare")]: flaggedSpare("v1"),
      [cellKey("v2", "spare")]: flaggedSpare("v2"),
    };
    const draft: Draft = {
      clientUuid: "c1",
      vehicleId: "v1",
      combinationId: "comb1",
      observedMemberVehicleIds: ["v1", "v2"],
      taskId: null,
      startedAt: new Date().toISOString(),
      odometerKm: null,
      comment: null,
      defectReport: null,
      positions,
      warnings: [],
    };

    render(
      <CaptureReview
        contexts={contexts}
        draft={draft}
        doneCells={new Set(Object.keys(positions))}
        onBack={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );

    const rows = screen.getAllByText(/^Spare, /);
    expect(rows.map((r) => r.textContent)).toEqual(["Spare, BAC039SP", "Spare, LINK6"]);
  });
});
