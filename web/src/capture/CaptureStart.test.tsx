import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { CaptureStart } from "./CaptureStart";
import { ActorContext } from "../auth/actorContext";
import { me } from "../test/fixtures";
import { expectNothingForbiddenSpoken } from "../test/spoken";
import type { CaptureContext } from "./captureContext";

// FR-INS-020's three pre-fill inputs: 8 days at 500km/day projects 412180
// to 416180. The reading is from an earlier day, so it is FR-INS-033's base.
const motive: CaptureContext = {
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: 412180,
  lastOdometerAt: "2026-08-19T06:00:00Z",
  lastOdometerAgeDays: 8,
  odometerBaseKm: 412180,
  odometerBaseAgeDays: 8,
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
    const { container } = renderStart(vi.fn());
    // Scoped to the readout: the confirm control names the same number, and
    // that it does is asserted separately below.
    expect(screen.getByText(/416,180/, { selector: "p" })).toBeInTheDocument();
    // Still on screen, because checking the dash against it is the point.
    expect(screen.getByText(/412,180 km/)).toBeInTheDocument();
    expectNothingForbiddenSpoken(container, /start inspection/);
  });

  // CR-010/OR-LEG-001 (TYRE-207): the odometer's warning names the reading,
  // never a legal standard.
  it("flags an implausible reading without a forbidden word", async () => {
    const { container } = renderStart(vi.fn());
    await type("999999");

    expect(screen.getByText(/a day since the 412,180 km reading 8 days ago/)).toBeInTheDocument();
    expectNothingForbiddenSpoken(container, /check the digits/);
  });

  // FR-INS-033 records CONFIRMED against the value sent, so a tick given to
  // one number must not carry over to the next. One Delete and a digit is
  // TYRE-171's normal correction.
  it("asks for a new tick after a Delete that keeps the warning up", async () => {
    renderStart(vi.fn());
    const user = await type("5121801");
    await user.click(screen.getByRole("checkbox", { name: /tick to confirm/i }));
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(screen.getByRole("checkbox", { name: /tick to confirm/i })).not.toBeChecked();
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeDisabled();
  });

  it("asks for a new tick after a digit that keeps the warning up", async () => {
    renderStart(vi.fn());
    const user = await type("512180");
    await user.click(screen.getByRole("checkbox", { name: /tick to confirm/i }));

    await type("0");

    expect(screen.getByRole("checkbox", { name: /tick to confirm/i })).not.toBeChecked();
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeDisabled();
  });

  // A digit past the seventh is dropped, so the value ticked is still the
  // one on screen.
  it("keeps the tick on a digit past the seventh", async () => {
    renderStart(vi.fn());
    const user = await type("5121801");
    await user.click(screen.getByRole("checkbox", { name: /tick to confirm/i }));

    await type("9");

    expect(screen.getByRole("checkbox", { name: /tick to confirm/i })).toBeChecked();
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

  // TYRE-171: one mis-tapped digit in six costs one Delete and the right
  // digit, not a re-type of the five the driver had right (NFR-USE-006).
  it("drops one digit on delete and keeps the rest", async () => {
    const onStart = vi.fn<Init>();
    renderStart(onStart);
    const user = await type("413509");

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("41,350", { selector: "p" })).toBeInTheDocument();

    await type("7");
    await user.click(screen.getByRole("button", { name: /start inspection/i }));
    expect(onStart.mock.calls[0][0].odometerKm).toBe(413507);
  });

  // The offer counts the days FR-INS-033 divides by, so a unit averaging
  // under the ceiling is never asked to tick its own projection.
  it("offers a projection its own check passes, late on the day after", async () => {
    vi.setSystemTime(new Date("2026-08-24T20:00:00Z"));
    renderStart(vi.fn(), {
      lastOdometerAt: "2026-08-23",
      lastOdometerAgeDays: 1,
      odometerBaseAgeDays: 1,
      averageDailyKm: 900,
    });
    const user = setup();

    await user.click(screen.getByRole("button", { name: /confirm 413,080 km/i }));

    expect(screen.queryByText(/a day since/)).toBeNull();
  });

  // A projection needs a rate as well as a reading. Without one there is
  // nothing to project, and the field starts empty rather than falling back to
  // the last reading, which is the value that must never arrive pre-filled.
  it("starts empty when the unit has no rate to project at", () => {
    renderStart(vi.fn(), { averageDailyKm: null });
    expect(screen.getByText(/000,000/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  // A second inspection the same day: projecting over no days would offer the
  // morning's reading itself, so the field starts empty instead.
  it("starts empty when the last reading was taken today", () => {
    renderStart(vi.fn(), { lastOdometerAgeDays: 0 });
    expect(screen.getByText(/000,000/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /confirm/i })).toBeNull();
  });

  // TYRE-171 (TYRE-330 f14): the timeline is written only by a submitted
  // inspection, so a unit added with an odometer on its record still has no
  // reading here, and the hint says which count is empty.
  it("says the count starts from inspections when none has read the odometer", () => {
    renderStart(vi.fn(), {
      lastOdometerKm: null,
      lastOdometerAt: null,
      lastOdometerAgeDays: null,
      averageDailyKm: null,
    });
    expect(
      screen.getByText("No odometer reading from an inspection yet. This one starts the count."),
    ).toBeInTheDocument();
  });

  // U55 (TYRE-342): the age beside the grouped reading groups too.
  it("groups a four-digit day count beside the last reading", () => {
    renderStart(vi.fn(), { lastOdometerAgeDays: 1000 });
    expect(screen.getByText("Last reading 412,180 km, 1,000 days ago")).toBeInTheDocument();
  });

  // A reading taken yesterday is one day, in the words formatTreadAge
  // writes for every other age the driver reads.
  it("says 1 day, not 1 days", () => {
    renderStart(vi.fn(), { lastOdometerAgeDays: 1 });
    expect(screen.getByText("Last reading 412,180 km, 1 day ago")).toBeInTheDocument();
  });

  // Rule 6 (TYRE-342): the count is the server's, in the fleet's days. At
  // 15:00 SAST a reading dated two days back is two and a half days old by
  // the browser clock, which rounds to 3.
  it("says the served day count whatever the browser clock", () => {
    vi.setSystemTime(new Date("2026-08-27T13:00:00Z"));
    renderStart(vi.fn(), { lastOdometerAt: "2026-08-25T00:00:00Z", lastOdometerAgeDays: 2 });
    expect(screen.getByText("Last reading 412,180 km, 2 days ago")).toBeInTheDocument();
  });

  // An API older than the field sends no count, and the browser clock does
  // not stand in for one (rule 6).
  it("leaves the age off when the server sends no count", () => {
    renderStart(vi.fn(), { lastOdometerAgeDays: undefined });
    expect(screen.getByText("Last reading 412,180 km")).toBeInTheDocument();
  });

  // Driver copy is straight-quoted (CLAUDE.md, Comments; /unslop).
  it("explains the projection in straight-quoted words", () => {
    renderStart(vi.fn());
    expect(
      screen.getByText(
        "Worked out from that reading and this unit's usual daily distance. Check it against the dash. Confirm it, type the real number, or skip it.",
      ),
    ).toBeInTheDocument();
  });

  // A corrected reading still meets a rejection: BR-INS-002 is unconditional,
  // so a backwards reading is refused at the cab rather than after the
  // walk-around (FR-INS-032).
  it("still refuses a reading below the last recorded one", async () => {
    const { container } = renderStart(vi.fn());
    await type("400000");

    expect(screen.getByRole("alert")).toHaveTextContent(/lower than the last recorded/i);
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeDisabled();
    expectNothingForbiddenSpoken(container, /lower than the last recorded/);
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

// FR-INS-062: the driver confirms the rig a controller set. A box's name is
// its fleet number and descriptor; e2e/rigs.spec.ts finds it by the fleet
// number within that name.
describe("CaptureStart's rig", () => {
  it("names each coupled unit's box by its fleet number and descriptor", () => {
    const { container } = renderStart(vi.fn(), {
      combination: {
        id: "c1",
        members: [
          { vehicleId: "v1", fleetNumber: "BAC039SP", sequence: 1, descriptor: "Horse" },
          { vehicleId: "v2", fleetNumber: "BAC711TR", sequence: 2, descriptor: "Link 1" },
        ],
      },
    });
    const rig = screen.getByRole("group", { name: "Your rig" });
    const motive = within(rig).getByRole("checkbox", { name: /BAC039SP.*Horse/ });
    expect(motive).toBeChecked();
    expect(motive).toBeDisabled();
    expect(within(rig).getByRole("checkbox", { name: /BAC711TR.*Link 1/ })).not.toBeChecked();
    expectNothingForbiddenSpoken(container, /coupled up/);
  });
});

// FR-CFG-021: the odometer field is captioned with the tenant's distance
// unit.
describe("CaptureStart's odometer unit", () => {
  it("shows the tenant's distance unit beside the field", () => {
    render(
      <ActorContext.Provider value={{ actor: me({ distanceUnit: "XKM" }), settled: true }}>
        <CaptureStart
          motive={motive}
          storageBlocked={false}
          attachedIds={["v1"]}
          onToggleAttached={vi.fn()}
          onStart={vi.fn()}
        />
      </ActorContext.Provider>,
    );
    expect(screen.getAllByText(/XKM/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/\bkm\b/)).not.toBeInTheDocument();
  });
});
