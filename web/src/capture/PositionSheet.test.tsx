import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";

import type { CaptureContext, CapturePosition } from "./captureContext";
import type { DraftPosition } from "./draft";
import type { RigPosition } from "./rig";
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

const rig: RigPosition = { position, context: ctx, displayNumber: 1 };

function props(overrides: {
  onChange?: (p: DraftPosition) => void;
  onDone?: (p: DraftPosition) => void;
}) {
  return {
    rig,
    ctx,
    onChange: overrides.onChange ?? vi.fn(),
    onDone: overrides.onDone ?? vi.fn(),
    onClose: vi.fn(),
  };
}

// Accessible names are driver-facing too: FIELD_LABEL reaches the driver as an
// aria-label, never as a text node, so a text-only query cannot see the very
// strings most likely to carry a forbidden word.
const spokenText = (container: HTMLElement) =>
  [
    container.textContent ?? "",
    ...Array.from(container.querySelectorAll("[aria-label]")).map(
      (el) => el.getAttribute("aria-label") ?? "",
    ),
  ]
    .join(" ")
    .toLowerCase();

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
  it("never shows the words inner, outer or centre", () => {
    const { container } = render(<PositionSheet {...props({})} />);
    const spoken = spokenText(container);
    for (const word of ["inner", "outer", "centre"]) {
      expect(spoken).not.toContain(word);
    }
  });

  // FR-INS-036, and CR-010 / OR-LEG-001: the tenant's configured policy, never
  // described as a legal limit.
  it("warns below the threshold without calling it a legal limit", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { container } = render(<PositionSheet {...props({})} />);
    await enter(user, ["3", "3", "4"], "800");

    expect(screen.getByRole("alert")).toHaveTextContent(/replacement point/i);
    const spoken = spokenText(container);
    for (const word of ["legal", "roadworth", "statutory", "minimum"]) {
      expect(spoken).not.toContain(word);
    }
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

  // NFR-OBS-007: measured, not assumed, and it cannot be added later.
  it("records how long the position took", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onDone = vi.fn<(p: DraftPosition) => void>();
    render(<PositionSheet {...props({ onDone })} />);
    await enter(user, ["9", "9", "9"], "800");
    await user.click(screen.getByRole("button", { name: /done ›/i }));

    expect(onDone.mock.calls[0][0].seconds).toBeGreaterThanOrEqual(0);
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
