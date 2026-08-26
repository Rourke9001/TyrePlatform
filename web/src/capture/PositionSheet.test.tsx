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
  positions: [position],
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

// Fake timers, advanced deliberately between fields. On real timers this
// test passes or fails according to how fast jsdom happens to be today, and
// the failure mode is a green test over corrupt data.
//
// The advance is wrapped in act(): it fires PositionSheet's setTimeout
// callback directly, outside any testing-library API, so nothing else
// flushes the resulting setState — an unwrapped advance leaves the DOM
// showing the pre-timer field and every aria-current read below stale,
// which would make this helper click Next for every digit regardless of
// whether the timer actually fired.
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function enter(user: UserEvent, treads: string[], pressure: string) {
  for (let i = 0; i < treads.length; i++) {
    await user.click(screen.getByRole("button", { name: treads[i] }));
    await advance(250);
    // A settling digit (4-9 on an empty field) auto-advances on the timer
    // above; a non-settling one (0-3) does not, and only then does the Next
    // key move the sheet on. The field's own aria-current says which case
    // this was — clicking Next after the timer already advanced would move a
    // second field and strand the one just typed, which the auto-advance
    // guard does not protect against: it only stops the timer's own callback
    // from re-firing on a field a *click* had already left, not the reverse.
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

  // FR-INS-029a: the driver never sees the words inner, outer or centre — the
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
  // before the position closes — this is the one place the flow deliberately
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

  // The other half of the guard above, and the reason it has to be a guard
  // rather than an unconditional hold: NFR-USE-001 is the constraint every
  // other decision in this app is subordinate to, and a Done tap that a clean
  // position does not need is paid on 27 of them on a superlink. The pair
  // pins that the hold is CONDITIONAL — either assertion alone is satisfied by
  // holding always or by never holding at all.
  it("finishes a position with nothing to flag without a further tap", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onDone })} />);
    await enter(user, ["9", "9", "9"], "800");

    // enter() ends 250ms after the last pressure digit, inside the beat that
    // lets a fourth digit or a correction land — so this is the hold being
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

  // NFR-OBS-007: measured, not assumed, and it cannot be added later. This
  // column feeds NFR-USE-001's three-minute median, so a hardcoded value or a
  // formula that just happens to never go negative has to fail here, not only
  // clear a "some number, and it's not negative" bar. enter()'s three settle
  // ticks plus the trailing pressure tick are exactly 1000ms of fake clock,
  // so the exact value pins the divisor along with the sign.
  it("records how long the position took", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onDone })} />);
    await enter(user, ["9", "9", "9"], "800");
    await user.click(screen.getByRole("button", { name: /done ›/i }));

    expect(onDone.mock.calls[0][0].seconds).toBe(1);
  });

  // NFR-PRO-003: a driver who reopens a position must not be credited with
  // time they did not spend re-entering it. The fresh-position case above is
  // vacuous here — carried.current is 0 on a fresh mount either way — so this
  // pins the `carried.current +` term on its own: mount already-complete
  // (unwarned, so Done needs no acknowledgement first), advance a known
  // amount, and the total must be the carried seconds plus what elapsed on
  // this visit, not a restart.
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

  // entry.ts's settle rule: does another digit still fit? "3" leaves room
  // (valueOf("30") = 30, under the 35mm ceiling) and must not auto-advance;
  // "4" does not (valueOf("40") = 40, over) and must. enter()'s tread
  // sequences elsewhere in this file only ever exercise one side of that
  // boundary at a time, so this pins both directly against the field's own
  // aria-current, with no Next press in either case to fall back on if the
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

  // FR-INS-040 asks what the driver DID about a warning, and closing the sheet
  // is not acknowledging it. Without this the warning that was on screen never
  // reaches the draft at all, so the review screen's "what the app found" never
  // mentions it and the audit record loses the one fact it exists to hold.
  // app.inspection_warning.response is nullable with no CHECK precisely so
  // absence can be recorded as absence (000022_inspection_warning).
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
  // behind — that would put a warning on the review screen for a value that no
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

  // The guard on the exit write, and the reason it is identity against this
  // mount's own state rather than a flag: a driver who reopens a finished
  // position to look at it and closes again must not have their recorded
  // ACKNOWLEDGED downgraded to an unanswered one.
  it("leaves a finished position's recorded response alone when it is only reopened", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onChange = vi.fn<(p: DraftPosition) => void>();
    const onClose = vi.fn();
    render(<PositionSheet {...props({ onChange, onClose })} initial={acknowledged} />);

    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
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

  // The clock is frozen at the sheet's own openedAt, the way CaptureFlow,
  // CaptureStart and CaptureReview each freeze theirs. FR-INS-035's implied
  // wear rate has elapsed time as its denominator, so a clock read during
  // render drifts away from the diagram's — and at the boundary the cell bands
  // Check while the sheet raises nothing and records an empty warnings array,
  // which is the display warning and the audit record not.
  it("bands against the clock the sheet opened with, not the clock at entry", async () => {
    vi.setSystemTime(new Date("2026-08-27T06:00:00Z"));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    // 5mm gone in the 30 days to mount is 5.07mm a month against a cohort of
    // 0.8 and a multiple of 3 — over the 2.4 trigger. Ninety days later the
    // same 5mm is 1.69 a month, which is under it, so a clock read at entry
    // answers the opposite question from a clock read at open.
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
  // in the register carries a spare count — so a rig opens one spare sheet per
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

  // FR-OFF-005 verbatim: EVERY entry, incrementally — not on completion.
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
  // this effect for one commit — an invocation-count guard lets the second
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
});
