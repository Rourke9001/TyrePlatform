import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CaptureStart } from "./CaptureStart";
import type { CaptureContext } from "./captureContext";

// FR-INS-020's three pre-fill inputs; frozen clock because 8 days at
// 500km/day projects 412180 to 416180, and a wall-clock read would move
// the expected value under the test.
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
    captureSpares: true,
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

  // FR-INS-020 verbatim: pre-filled with a projection, not the last
  // reading. Confirming it cannot record last inspection's value as this
  // one's.
  it("offers a projection from the last reading rather than the reading itself", () => {
    renderStart(vi.fn());
    // Scoped to the readout: the confirm control names the same number, and
    // that it does is asserted separately below.
    expect(screen.getByText(/416,180/, { selector: "p" })).toBeInTheDocument();
    // Still on screen, because checking the dash against it is the point.
    expect(screen.getByText(/412,180 km/)).toBeInTheDocument();
  });

  // "CONFIRMED values are recorded to the odometer timeline": an untouched
  // pre-fill is not confirmed, so an unconfirmed tap records no reading at
  // all (NFR-PRO-003), keeping DR-018's append-only timeline free of an
  // unobserved distance.
  it("records nothing when the driver never confirms the projection", async () => {
    const onStart = vi.fn<Init>();
    renderStart(onStart);
    const user = setup();

    await user.click(screen.getByRole("button", { name: /start inspection/i }));

    expect(onStart).toHaveBeenCalledOnce();
    expect(onStart.mock.calls[0][0].odometerKm).toBeNull();
  });

  // One tap becomes the driver's own reading; "confirming beats typing six
  // digits" is the sponsor's trade (Q6), sound only because the tap names
  // the number it confirms.
  it("records the projection once the driver confirms it", async () => {
    const onStart = vi.fn<Init>();
    renderStart(onStart);
    const user = setup();

    await user.click(screen.getByRole("button", { name: /confirm 416,180 km/i }));
    await user.click(screen.getByRole("button", { name: /start inspection/i }));

    expect(onStart.mock.calls[0][0].odometerKm).toBe(416180);
  });

  // FR-INS-020: optional, and never a blocker. An unconfirmed projection is
  // recorded as absent and the inspection proceeds. The odometer must not be
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
  // the last reading, which is the value that must never arrive pre-filled.
  it("starts empty when the unit has no rate to project at", () => {
    renderStart(vi.fn(), { averageDailyKm: null });
    expect(screen.getByText(/000,000/)).toBeInTheDocument();
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
    expect(screen.queryByText(/000,000/)).toBeNull();
    expect(screen.queryByText(/416,180/)).toBeNull();
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeEnabled();
  });
});
