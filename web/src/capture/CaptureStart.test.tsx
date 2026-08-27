import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CaptureStart } from "./CaptureStart";
import type { CaptureContext } from "./captureContext";

// A unit with a reading on record, a recent date for it and a rate to carry
// it forward — the three inputs FR-INS-020's pre-fill needs, and the shape the
// e2e suite cannot reach: the fixture seeds no vehicle_odometer_reading rows,
// so lastOdometerKm is null throughout and every browser spec meets the empty
// field instead.
//
// Eight days at 500 km a day projects 412 180 to 416 180, which is why the
// clock below is frozen: a projection read off the wall clock would move every
// day and the expected value here would be a second implementation of the
// arithmetic under test.
const motive: CaptureContext = {
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: 412180,
  lastOdometerAt: "2026-08-19T06:00:00Z",
  averageDailyKm: 500,
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

const setup = () => userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

const type = async (digits: string) => {
  const user = setup();
  for (const d of digits) {
    await user.click(screen.getByRole("button", { name: d }));
  }
  return user;
};

describe("CaptureStart's odometer", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date("2026-08-27T06:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // FR-INS-020 as written: "pre-filled with a projection from the unit's last
  // known reading". A projection, not the reading — the number on screen is
  // one the unit has plausibly reached, so confirming it cannot record last
  // inspection's value as this one's.
  it("offers a projection from the last reading rather than the reading itself", () => {
    renderStart(vi.fn());
    // Scoped to the readout: the confirm control names the same number, and
    // that it does is asserted separately below.
    expect(screen.getByText(/416 180/, { selector: "p" })).toBeInTheDocument();
    // Still on screen, because checking the dash against it is the point.
    expect(screen.getByText(/412 180 km/)).toBeInTheDocument();
  });

  // The clause the whole shape turns on: "CONFIRMED values are recorded to the
  // vehicle odometer timeline". An untouched pre-fill is not a confirmed
  // value, so a driver who taps Start without looking at the field records no
  // reading at all — which is NFR-PRO-003's absent value in place of an
  // invented one, and keeps DR-018's append-only timeline free of a distance
  // nobody observed.
  it("records nothing when the driver never confirms the projection", async () => {
    const onStart = vi.fn<Init>();
    renderStart(onStart);
    const user = setup();

    await user.click(screen.getByRole("button", { name: /start inspection/i }));

    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.calls[0][0].odometerKm).toBeNull();
  });

  // The other half: one tap, and the projection becomes the driver's own
  // reading. "Confirming beats typing six digits" is the sponsor's trade
  // (Q6), and it is only sound because the tap is on a control that names the
  // number it is confirming.
  it("records the projection once the driver confirms it", async () => {
    const onStart = vi.fn<Init>();
    renderStart(onStart);
    const user = setup();

    await user.click(screen.getByRole("button", { name: /confirm 416 180 km/i }));
    await user.click(screen.getByRole("button", { name: /start inspection/i }));

    expect(onStart.mock.calls[0][0].odometerKm).toBe(416180);
  });

  // FR-INS-020: optional, and never a blocker. An unconfirmed projection is
  // recorded as absent and the inspection proceeds — the odometer must not be
  // able to stop a driver capturing tyres.
  it("lets the inspection start with the odometer left alone", () => {
    renderStart(vi.fn());
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeEnabled();
  });

  // "confirm or CORRECT". Typing supersedes the projection outright rather
  // than editing it, so a corrected reading is the driver's six digits and
  // never a hybrid of theirs and the projection's.
  it("records the digits the driver entered instead of the projection", async () => {
    const onStart = vi.fn<Init>();
    renderStart(onStart);
    const user = await type("413500");

    await user.click(screen.getByRole("button", { name: /start inspection/i }));

    expect(onStart.mock.calls[0][0].odometerKm).toBe(413500);
  });

  // A projection needs a rate as well as a reading. Without one there is
  // nothing to project, and the field starts empty rather than falling back to
  // the last reading — which is the value that must never arrive pre-filled.
  it("starts empty when the unit has no rate to project at", () => {
    renderStart(vi.fn(), { averageDailyKm: null });
    expect(screen.getByText(/000 000/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  // A corrected reading still meets a rejection: BR-INS-002 is unconditional,
  // so a backwards reading is refused at the cab rather than after the
  // walk-around (FR-INS-032).
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
    expect(screen.queryByText(/416 180/)).toBeNull();
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeEnabled();
  });
});
