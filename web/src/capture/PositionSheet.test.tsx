import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";

import type { CaptureContext, CapturePosition } from "./captureContext";
import type { DraftPosition } from "./draft";
import { cellKey } from "./draft";
import type { RigPosition } from "./rig";
import { expectNothingForbiddenSpoken } from "../test/spoken";
import { PositionSheet } from "./PositionSheet";

const position: CapturePosition = {
  id: "p1",
  vehicleId: "v1",
  code: "1",
  sequence: 1,
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
};

const ctx: CaptureContext = {
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  registration: null,
  unitKind: "HORSE",
  lastOdometerKm: null,
  lastOdometerAt: null,
  averageDailyKm: null,
  positions: [position],
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

const rig: RigPosition = {
  position,
  key: cellKey(ctx.vehicleId, position.id),
  context: ctx,
  displayNumber: 1,
};

function props(overrides: {
  onChange?: (p: DraftPosition) => void;
  onDone?: (p: DraftPosition) => void;
  onClose?: () => void;
}) {
  return {
    rig,
    ctx,
    onChange: overrides.onChange ?? vi.fn(),
    onDone: overrides.onDone ?? vi.fn(),
    onClose: overrides.onClose ?? vi.fn(),
  };
}

const acknowledged: DraftPosition = {
  positionId: "p1",
  vehicleId: "v1",
  tyreId: null,
  treads: [3, 3, 4],
  pressureKpa: 800,
  pressureTemperature: "UNKNOWN",
  damageFlag: false,
  note: null,
  seconds: 6,
  warnings: [{ code: "FR-INS-036", enteredValue: "3", response: "ACKNOWLEDGED" }],
};

// Fake timers, advanced inside act(): this fires PositionSheet's own
// setTimeout directly, outside any testing-library API. An unwrapped
// advance leaves the DOM stale and would click Next regardless of whether
// the timer fired.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function enter(user: UserEvent, treads: string[], pressure: string) {
  for (let i = 0; i < treads.length; i++) {
    await user.click(screen.getByRole("button", { name: treads[i] }));
    await advance(250);
    // A settling digit (4-9 empty) auto-advances on the timer; a
    // non-settling one (0-3) needs the Next click. aria-current says which
    // case ran.
    const stillOnField = screen.getByLabelText(`Tread reading ${i + 1} of ${treads.length}`);
    if (stillOnField.getAttribute("aria-current") === "true") {
      await user.click(screen.getByRole("button", { name: /next ›/i }));
    }
  }
  for (const d of pressure.split("")) {
    await user.click(screen.getByRole("button", { name: d }));
  }
  await advance(250);
}

describe("PositionSheet", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("enters three readings and a pressure with no native keyboard", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onDone })} />);

    // No input element anywhere: the OS keyboard costs a driver seconds per
    // field and covers half the screen (web/CLAUDE.md).
    expect(document.querySelector("input")).toBeNull();

    await user.click(screen.getByRole("button", { name: "1" }));
    await user.click(screen.getByRole("button", { name: "3" }));
    expect(screen.getByLabelText(/Tread reading 1 of 3/)).toHaveTextContent("13");
  });

  // FR-INS-029a: the driver never sees the words inner, outer or centre. The
  // prototype's Outer/Centre/Inner labels are not carried over (decision D-A).
  // Swept with the one shared list (test/spoken.ts), which carries CR-010's
  // compliance words with them.
  it("never speaks a forbidden word on an untouched sheet", () => {
    const { container } = render(<PositionSheet {...props({})} />);
    expectNothingForbiddenSpoken(container, /tread reading 1 of 3/);
  });

  // FR-INS-036, and CR-010 / OR-LEG-001: the tenant's configured policy, never
  // described as a legal limit.
  it("warns below the threshold without calling it a legal limit", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = render(<PositionSheet {...props({})} />);
    await enter(user, ["3", "3", "4"], "800");

    expect(screen.getByRole("alert")).toHaveTextContent(/replacement point/i);
    expectNothingForbiddenSpoken(container, /replacement point/);
  });

  // FR-INS-040: the acknowledgement is recorded, so the driver has to see it
  // before the position closes. This is the one place the flow deliberately
  // does not auto-advance.
  it("holds a warned position until the driver acknowledges", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onDone })} />);
    await enter(user, ["3", "3", "4"], "800");

    expect(onDone).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /seen it/i }));

    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0][0].warnings[0]).toMatchObject({
      code: "FR-INS-036",
      response: "ACKNOWLEDGED",
    });
  });

  // The hold must be CONDITIONAL, not unconditional: NFR-USE-001 makes an
  // unnecessary Done tap on 27 positions costly. Either assertion alone is
  // satisfied by holding always or never.
  it("finishes a position with nothing to flag without a further tap", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onDone })} />);
    await enter(user, ["9", "9", "9"], "800");

    // enter() ends 250ms after the last pressure digit, inside the beat that
    // lets a fourth digit or a correction land, so this is the hold being
    // real, not the sheet having no opinion.
    expect(onDone).not.toHaveBeenCalled();
    await advance(300);

    expect(onDone).toHaveBeenCalledOnce();
    expect(onDone.mock.calls[0][0].pressureKpa).toBe(800);
    expect(onDone.mock.calls[0][0].warnings).toEqual([]);
  });

  // The hold may only act on the entry it was armed against. A
  // driver correcting a mis-read gauge inside the beat is entitled to an open
  // sheet and an incomplete position.
  it("does not finish a position whose pressure moved inside the hold", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onDone })} />);
    await enter(user, ["9", "9", "9"], "800");
    await user.click(screen.getByRole("button", { name: "Delete" }));
    await advance(600);

    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Pressure")).toHaveTextContent("–");
  });

  // NFR-OBS-007: measured, not assumed, feeding NFR-USE-001's median, so a
  // hardcoded or sign-only-checked value must fail here. enter()'s settle
  // ticks are exactly 1000ms of fake clock.
  it("records how long the position took", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onDone })} />);
    await enter(user, ["9", "9", "9"], "800");
    await user.click(screen.getByRole("button", { name: /done ›/i }));

    expect(onDone.mock.calls[0][0].seconds).toBe(1);
  });

  // NFR-PRO-003: reopening a position must not credit time not spent
  // re-entering. Pins the carried.current + elapsed term alone against a
  // fresh-mount (0) baseline.
  it("adds elapsed time to what was already carried on a reopened position", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    render(
      <PositionSheet
        {...props({ onDone })}
        initial={{
          positionId: "p1",
          vehicleId: "v1",
          tyreId: null,
          treads: [13, 13, 14],
          pressureKpa: 800,
          pressureTemperature: "UNKNOWN",
          damageFlag: false,
          note: null,
          seconds: 6,
          warnings: [],
        }}
      />,
    );
    await advance(2000);
    await user.click(screen.getByRole("button", { name: /done ›/i }));

    expect(onDone.mock.calls[0][0].seconds).toBe(8);
  });

  // entry.ts's settle rule pinned at both edges of the 35mm ceiling
  // directly against aria-current, with no Next press as a fallback if
  // auto-advance itself is broken.
  it("auto-advances once a digit settles the field", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PositionSheet {...props({})} />);

    await user.click(screen.getByRole("button", { name: "4" }));
    await advance(250);

    expect(screen.getByLabelText(/Tread reading 1 of 3/)).not.toHaveAttribute("aria-current");
    expect(screen.getByLabelText(/Tread reading 2 of 3/)).toHaveAttribute("aria-current", "true");
  });

  it("does not auto-advance a digit that leaves the field unsettled", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PositionSheet {...props({})} />);

    await user.click(screen.getByRole("button", { name: "3" }));
    await advance(250);

    expect(screen.getByLabelText(/Tread reading 1 of 3/)).toHaveAttribute("aria-current", "true");
  });

  // FR-INS-040 asks what the driver DID; closing is not acknowledging.
  // Without this write the warning never reaches the draft, and the audit
  // record loses the one fact it exists to hold (000022_inspection_warning).
  it("records an unanswered warning when the position is closed rather than finished", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn<(p: DraftPosition) => void>();
    const onDone = vi.fn<(p: DraftPosition) => void>();
    const onClose = vi.fn();
    render(<PositionSheet {...props({ onChange, onDone, onClose })} />);
    await enter(user, ["3", "3", "4"], "800");

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onDone).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onChange.mock.lastCall?.[0].warnings).toEqual([
      { code: "FR-INS-036", enteredValue: "3", response: null },
    ]);
  });

  // The state at exit, not every warning typed through on the way. A reading
  // the driver corrected before leaving must not leave an unanswered record
  // behind. That would put a warning on the review screen for a value that no
  // longer exists.
  it("does not record a warning the driver corrected before closing", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onChange })} />);
    await enter(user, ["3", "5", "6"], "800");
    expect(screen.getByRole("alert")).toBeTruthy();

    await user.click(screen.getByLabelText("Tread reading 1 of 3"));
    await user.click(screen.getByRole("button", { name: "7" }));
    await advance(250);
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(screen.queryByRole("alert")).toBeNull();
    expect(onChange.mock.lastCall?.[0].warnings).toEqual([]);
  });

  // The guard on the exit write: a driver who reopens a finished position to
  // look at it and closes again must not have their recorded ACKNOWLEDGED
  // downgraded to an unanswered one.
  it("leaves a finished position's recorded response alone when it is only reopened", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn<(p: DraftPosition) => void>();
    const onClose = vi.fn();
    render(<PositionSheet {...props({ onChange, onClose })} initial={acknowledged} />);

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  // The same guard against the tap that actually happens. Reading a value off
  // a field on a phone means tapping it, and a focus tap builds a fresh entry
  // state holding identical readings, so identity alone cannot tell looking
  // from editing. Both exits are covered here because both write: the
  // incremental save fires on the tap, and close() fires on the way out.
  it("keeps the recorded response when a driver taps a field and changes nothing", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onChange })} initial={acknowledged} />);

    await user.click(screen.getByLabelText("Tread reading 1 of 3"));
    await advance(250);
    await user.click(screen.getByRole("button", { name: "Close" }));

    for (const call of onChange.mock.calls) {
      expect(call[0].warnings).toEqual([
        { code: "FR-INS-036", enteredValue: "3", response: "ACKNOWLEDGED" },
      ]);
    }
  });

  // And the other half of the same rule: a visit that moves a reading answers
  // for the entry it leaves behind. The code and the entered value here are
  // the ones the previous visit acknowledged, so only the changed reading
  // separates this from the case above.
  it("records an unanswered warning when a reopened position is edited and closed", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onChange })} initial={acknowledged} />);

    // 4, not a deeper reading: this position's governing value has to stay
    // the 3 the previous visit acknowledged, and the change has to stay
    // inside BR-ANL-007's spread, so the recorded list differs from the
    // previous visit's in the response alone.
    await user.click(screen.getByLabelText("Tread reading 1 of 3"));
    await user.click(screen.getByRole("button", { name: "4" }));
    await advance(250);
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onChange.mock.lastCall?.[0].treads).toEqual([4, 3, 4]);
    expect(onChange.mock.lastCall?.[0].warnings).toEqual([
      { code: "FR-INS-036", enteredValue: "3", response: null },
    ]);
  });

  // The tread bands are final the moment the last reading is in, and a
  // pressure may never be taken (000023 accepts NULL). Holding the warning
  // back until then hides it on the diagram as well as here.
  it("warns on the treads before a pressure has been entered", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PositionSheet {...props({})} />);

    for (const [i, d] of ["3", "3", "4"].entries()) {
      await user.click(screen.getByRole("button", { name: d }));
      await advance(250);
      const field = screen.getByLabelText(`Tread reading ${i + 1} of 3`);
      if (field.getAttribute("aria-current") === "true") {
        await user.click(screen.getByRole("button", { name: /next ›/i }));
      }
    }

    expect(screen.getByLabelText("Pressure")).toHaveTextContent("–");
    expect(screen.getByRole("alert")).toHaveTextContent(/replacement point/i);
  });

  // Clock frozen at the sheet's own openedAt, like CaptureFlow/CaptureStart/
  // CaptureReview: FR-INS-035's rate has elapsed time as its denominator,
  // and a render-time clock would drift from the diagram's.
  it("bands against the clock the sheet opened with, not the clock at entry", async () => {
    vi.setSystemTime(new Date("2026-08-27T06:00:00Z"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    // 5mm in 30 days is 5.07mm/month (over the 2.4 trigger); the same 5mm
    // at 90 days is 1.69 (under it), so a clock read at entry vs at open
    // answers opposite questions.
    const wearing = {
      ...position,
      previousGoverningMm: 14,
      previousReadingAt: "2026-07-28T06:00:00Z",
    };
    const wearingCtx: CaptureContext = {
      ...ctx,
      positions: [wearing],
      cohortWearRateMmPerMonth: { "STEER:FIXED": 0.8 },
    };
    render(
      <PositionSheet
        {...props({ onDone })}
        rig={{ ...rig, position: wearing, context: wearingCtx }}
        ctx={wearingCtx}
      />,
    );

    vi.setSystemTime(new Date("2026-10-26T06:00:00Z"));
    await enter(user, ["9", "9", "9"], "800");
    await advance(600);

    expect(screen.getByRole("alert")).toHaveTextContent(/wearing far faster/i);
    // And the hold held, so the response FR-INS-040 asks for is still to come.
    expect(onDone).not.toHaveBeenCalled();
  });

  // A spare has no walk-around number to be named by, and every configuration
  // in the register carries a spare count, so a rig opens one spare sheet per
  // unit, and only the unit's own identity tells them apart (BR-VEH-003).
  it("names a spare's sheet for the unit that owns it", () => {
    const spare = { ...position, isSpare: true };
    render(<PositionSheet {...props({})} rig={{ ...rig, position: spare, displayNumber: null }} />);
    expect(screen.getByRole("region", { name: "Spare, BAC039SP" })).toBeInTheDocument();
  });

  // FR-OFF-006: reopening a captured position shows what was entered.
  // Without this the draft survives a restart and the screen does not,
  // which from the driver's side is the same as having lost it.
  it("shows the saved readings when a position is reopened", () => {
    render(
      <PositionSheet
        {...props({})}
        initial={{
          positionId: "p1",
          vehicleId: "v1",
          tyreId: null,
          treads: [13, 13, 14],
          pressureKpa: 800,
          pressureTemperature: "UNKNOWN",
          damageFlag: false,
          note: null,
          seconds: 6,
          warnings: [],
        }}
      />,
    );
    expect(screen.getByLabelText(/Tread reading 1 of 3/)).toHaveTextContent("13");
    expect(screen.getByLabelText(/Pressure/)).toHaveTextContent("800");
  });

  // FR-OFF-005 verbatim: EVERY entry, incrementally, not on completion.
  // The flat-battery case happens mid-position, which is exactly the state
  // a per-position save does not cover.
  it("persists on the first digit, not on completion", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onChange })} />);

    await user.click(screen.getByRole("button", { name: "1" }));

    expect(onChange).toHaveBeenCalled();
    expect(onChange.mock.calls[0][0].treads[0]).toBe(1);
  });

  // FR-OFF-005 again: "every entry" means what the driver typed, not the
  // sheet opening. main.tsx renders under StrictMode, which double-invokes
  // this effect for one commit. An invocation-count guard lets the second
  // firing through and reports an untouched position as an edited one.
  it("does not fire onChange for the untouched position on a StrictMode mount", () => {
    const onChange = vi.fn<(p: DraftPosition) => void>();
    render(
      <StrictMode>
        <PositionSheet {...props({ onChange })} />
      </StrictMode>,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  // TYRE-148/NFR-USE-011: a driver back from a phone call with 2 of 3
  // readings expects the next digit to fill the empty box, not restart
  // tread 1.
  it("reopens a half-entered position on its first empty field", () => {
    render(
      <PositionSheet
        {...props({})}
        initial={{
          positionId: "p1",
          vehicleId: "v1",
          tyreId: null,
          treads: [12, 13, null],
          pressureKpa: null,
          pressureTemperature: "UNKNOWN",
          damageFlag: false,
          note: null,
          seconds: 4,
          warnings: [],
        }}
      />,
    );
    expect(screen.getByLabelText(/Tread reading 3 of 3/)).toHaveAttribute("aria-current", "true");
    expect(screen.getByLabelText(/Tread reading 1 of 3/)).not.toHaveAttribute("aria-current");
  });

  // Treads done, pressure not: the pressure field is the empty one.
  it("reopens a tread-complete position on the pressure field", () => {
    render(
      <PositionSheet
        {...props({})}
        initial={{
          positionId: "p1",
          vehicleId: "v1",
          tyreId: null,
          treads: [12, 13, 14],
          pressureKpa: null,
          pressureTemperature: "UNKNOWN",
          damageFlag: false,
          note: null,
          seconds: 4,
          warnings: [],
        }}
      />,
    );
    expect(screen.getByLabelText(/Pressure/)).toHaveAttribute("aria-current", "true");
  });

  // A finished position reopened to LOOK at is seeded on field 1: there is
  // nothing empty to resume into, and a digit there is an edit the driver
  // chose (the look-and-leave guard still applies).
  it("reopens a complete position on the first field", () => {
    render(
      <PositionSheet
        {...props({})}
        initial={{
          positionId: "p1",
          vehicleId: "v1",
          tyreId: null,
          treads: [12, 13, 14],
          pressureKpa: 800,
          pressureTemperature: "UNKNOWN",
          damageFlag: false,
          note: null,
          seconds: 4,
          warnings: [],
        }}
      />,
    );
    expect(screen.getByLabelText(/Tread reading 1 of 3/)).toHaveAttribute("aria-current", "true");
  });

  // TYRE-155: one tap, on the spare sheet only. A running position never
  // shows it. A running wheel with no tyre is a fitment fact, not this.
  it("offers 'No spare on this unit' on a spare sheet and nowhere else", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onAbsent = vi.fn();
    const spare = { ...position, id: "s1", isSpare: true, axleClass: "SPARE", axleNumber: null };
    const { container } = render(
      <PositionSheet
        {...props({})}
        rig={{ ...rig, position: spare, key: cellKey("v1", "s1"), displayNumber: null }}
        onAbsent={onAbsent}
      />,
    );
    await user.click(screen.getByRole("button", { name: /no spare on this unit/i }));
    expect(onAbsent).toHaveBeenCalledWith(spare, true);
    expectNothingForbiddenSpoken(container, /no spare on this unit/i);
  });

  it("shows no spare action on a running position", () => {
    const { container } = render(<PositionSheet {...props({})} onAbsent={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /no spare/i })).toBeNull();
    expectNothingForbiddenSpoken(container, /tread reading 1 of 3/);
  });

  it("lets the driver take back an absent mark from the same sheet", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onAbsent = vi.fn();
    const spare = { ...position, id: "s1", isSpare: true, axleClass: "SPARE", axleNumber: null };
    const { container } = render(
      <PositionSheet
        {...props({})}
        rig={{ ...rig, position: spare, key: cellKey("v1", "s1"), displayNumber: null }}
        absent
        onAbsent={onAbsent}
      />,
    );
    await user.click(screen.getByRole("button", { name: /spare is here/i }));
    expect(onAbsent).toHaveBeenCalledWith(spare, false);
    expectNothingForbiddenSpoken(container, /spare is here/i);
  });

  // TYRE-147: the sheet hides the diagram (capture.css), so the frame the
  // server maps by has to be ON the sheet. A spare has no side and no glyph.
  it("shows the plan-view glyph for the tyre's side and the one-line hint", () => {
    const { container } = render(
      <PositionSheet {...props({})} rig={{ ...rig, position: { ...position, side: "RIGHT" } }} />,
    );
    expect(screen.getByRole("img", { name: /right side of the vehicle/i })).toBeInTheDocument();
    expect(screen.getByText(/left to right, as seen from above/i)).toBeInTheDocument();
    expectNothingForbiddenSpoken(container, /as seen from above/i);
  });

  it("shows no glyph on a spare", () => {
    const spare = { ...position, isSpare: true, axleClass: "SPARE", axleNumber: null, side: null };
    render(<PositionSheet {...props({})} rig={{ ...rig, position: spare, displayNumber: null }} />);
    expect(screen.queryByRole("img")).toBeNull();
  });
});
