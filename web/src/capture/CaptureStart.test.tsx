import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CaptureStart } from "./CaptureStart";
import type { CaptureContext } from "./captureContext";

// A unit with a reading on record and a recent date for it — the shape that
// makes a prefill possible at all. The e2e suite cannot reach this path: the
// fixture seeds no vehicle_odometer_reading rows, so lastOdometerKm is null
// throughout and every browser spec starts from an empty field either way.
const motive: CaptureContext = {
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: 412180,
  lastOdometerAt: "2026-08-19T06:00:00Z",
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

type Init = Parameters<typeof CaptureStart>[0]["onStart"];

function renderStart(onStart: Init, over: Partial<CaptureContext> = {}) {
  return render(
    <CaptureStart
      motive={{ ...motive, ...over }}
      storageBlocked={false}
      attachedIds={["v1"]}
      onToggleAttached={vi.fn()}
      onStart={onStart}
    />,
  );
}

const type = async (digits: string) => {
  const user = userEvent.setup();
  for (const d of digits) {
    await user.click(screen.getByRole("button", { name: d }));
  }
  return user;
};

describe("CaptureStart's odometer", () => {
  // FR-INS-064 / DR-018. The reading is an observation of an instrument, and
  // the field a driver is asked to transcribe it into must not arrive already
  // holding an answer.
  it("starts empty even when the unit has a reading on record", () => {
    renderStart(vi.fn());
    expect(screen.getByText(/000 000/)).toBeInTheDocument();
    // Still on screen, because checking the dash against it is the point.
    expect(screen.getByText(/412 180 km/)).toBeInTheDocument();
  });

  // The failure the empty field exists to prevent, stated as the outcome
  // rather than as the field's contents: a driver who taps Start without
  // touching the odometer must record NO reading, never the last inspection's
  // as this one's. An equal value trips nothing — FR-INS-032 compares `>=`
  // and an unchanged reading implies no daily distance for FR-INS-033 — so
  // the zero-distance interval would reach an append-only timeline unopposed.
  it("records no reading rather than last inspection's when the driver enters none", async () => {
    const onStart = vi.fn<Init>();
    renderStart(onStart);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /start inspection/i }));

    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.calls[0][0].odometerKm).toBeNull();
  });

  // FR-INS-020: optional, and never a blocker. An absent reading is recorded
  // as absent and the inspection proceeds — the odometer must not be able to
  // stop a driver capturing tyres.
  it("lets the inspection start with the odometer left alone", () => {
    renderStart(vi.fn());
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeEnabled();
  });

  it("records the digits the driver entered", async () => {
    const onStart = vi.fn<Init>();
    renderStart(onStart);
    const user = await type("413500");

    await user.click(screen.getByRole("button", { name: /start inspection/i }));

    expect(onStart.mock.calls[0][0].odometerKm).toBe(413500);
  });

  // An empty field still meets a rejection: BR-INS-002 is unconditional, so a
  // backwards reading is refused at the cab rather than after the walk-around
  // (FR-INS-032).
  it("still refuses a reading below the last recorded one", async () => {
    renderStart(vi.fn());
    await type("400000");

    expect(screen.getByRole("alert")).toHaveTextContent(/lower than the last recorded/i);
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeDisabled();
  });

  // FR-INS-020 again, from the other side: a trailer has no odometer field at
  // all, and distance is never apportioned to a towed unit (FR-INS-064).
  it("asks a trailer for nothing", () => {
    renderStart(vi.fn(), { unitKind: "TRAILER" });
    expect(screen.queryByText(/000 000/)).toBeNull();
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeEnabled();
  });
});
