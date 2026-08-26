import { describe, expect, it } from "vitest";

import { applyKey, newEntryState } from "./entry";
import type { EntryState } from "./entry";

const whole = { treadReadingCount: 3, granularityMm: 1.0 };
const tenths = { treadReadingCount: 3, granularityMm: 0.1 };
const halves = { treadReadingCount: 3, granularityMm: 0.5 };

function type(start: EntryState, digits: string, opts: typeof whole) {
  return digits.split("").reduce(
    (acc, d) => {
      const r = applyKey(acc.state, { type: "digit", digit: d }, opts);
      return { state: r.state, settled: r.settled };
    },
    { state: start, settled: false },
  );
}

describe("applyKey at whole-millimetre granularity", () => {
  it("accumulates digits into the focused field", () => {
    const { state } = type(newEntryState(3), "13", whole);
    expect(state.treads[0]).toBe(13);
  });

  // The rule is one sentence: settle when appending any further digit would
  // exceed the ceiling. At 1.0mm that means 4..9 settle on the first press
  // (40 and up are past the 35mm limit) while 1, 2 and 3 wait, because
  // 10-35mm are real readings.
  it("settles a first digit that cannot grow", () => {
    const r = applyKey(newEntryState(3), { type: "digit", digit: "7" }, whole);
    expect(r.state.treads[0]).toBe(7);
    expect(r.settled).toBe(true);
  });

  it("waits on a first digit that can still grow", () => {
    const r = applyKey(newEntryState(3), { type: "digit", digit: "1" }, whole);
    expect(r.state.treads[0]).toBe(1);
    expect(r.settled).toBe(false);
  });

  it("settles once a second digit lands", () => {
    const { settled, state } = type(newEntryState(3), "13", whole);
    expect(state.treads[0]).toBe(13);
    expect(settled).toBe(true);
  });

  // FR-INS-030: 0-35mm is a rejection, not a warning. Rather than showing an
  // error for a value that cannot exist, the keypad restarts on the digit the
  // driver just pressed — which is almost always what they meant.
  it("restarts rather than accepting a value past the ceiling", () => {
    const { state } = type(newEntryState(3), "39", whole);
    expect(state.treads[0]).toBe(9);
  });

  it("moves to the next field on next, and to pressure after the last tread", () => {
    let s = newEntryState(3);
    s = applyKey(s, { type: "next" }, whole).state;
    expect(s.field).toBe(1);
    s = applyKey(applyKey(s, { type: "next" }, whole).state, { type: "next" }, whole).state;
    expect(s.field).toBe(3); // count === 3, so field 3 is pressure
  });

  it("clears the focused field on delete and stays put", () => {
    const { state } = type(newEntryState(3), "13", whole);
    const r = applyKey(state, { type: "delete" }, whole);
    expect(r.state.treads[0]).toBeNull();
    expect(r.state.field).toBe(0);
  });

  // Any-order completion: tapping a field goes straight to it, which is how a
  // driver corrects one number without re-entering the other two.
  it("focuses a field directly", () => {
    const r = applyKey(newEntryState(3), { type: "focus", field: 2 }, whole);
    expect(r.state.field).toBe(2);
  });

  // Boundary-exact test R-12a: 35mm is the valid ceiling, and the settle rule
  // uses strict >, not >=. After digit 3: 30 > 35 is false, so it waits.
  // After digit 5: 35 > 35 is false so the value is kept; then 350 > 35 is
  // true so it settles.
  it("settles on 35mm at the ceiling without overflow", () => {
    const { state, settled } = type(newEntryState(3), "35", whole);
    expect(state.treads[0]).toBe(35);
    expect(settled).toBe(true);
  });

  // Boundary-exact test R-12b: 36mm overflows the ceiling, so it restarts on
  // the digit just pressed (6).
  it("restarts on 36mm just over the ceiling", () => {
    const { state } = type(newEntryState(3), "36", whole);
    expect(state.treads[0]).toBe(6);
  });
});

describe("applyKey on the pressure field", () => {
  const atPressure = () => ({ ...newEntryState(3), field: 3 });

  it("accepts three digits and settles when a fourth would exceed 1200 kPa", () => {
    const { state, settled } = type(atPressure(), "800", whole);
    expect(state.pressureKpa).toBe(800);
    expect(settled).toBe(true);
  });

  // FR-INS-031's ceiling is 1200, so a leading 1 keeps room for a fourth
  // digit and must not settle early — 1000 kPa is a real reading.
  it("waits for a fourth digit where one is still possible", () => {
    const { state, settled } = type(atPressure(), "120", whole);
    expect(state.pressureKpa).toBe(120);
    expect(settled).toBe(false);
  });

  it("accepts the four-digit value", () => {
    const { state } = type(atPressure(), "1000", whole);
    expect(state.pressureKpa).toBe(1000);
  });

  // Boundary-exact test R-12c: 1200 kPa is the valid ceiling, and at three
  // digits 1200 > 1200 is false so the field must NOT settle early — a fourth
  // digit is still possible and the driver must be able to enter 1200.
  it("waits on 1200 kPa and does not settle at three digits", () => {
    const { state, settled } = type(atPressure(), "120", whole);
    expect(state.pressureKpa).toBe(120);
    expect(settled).toBe(false);
  });

  // Boundary-exact test R-12d: 1201 kPa overflows the ceiling, so it restarts
  // on the digit just pressed (1).
  it("restarts on 1201 kPa just over the ceiling", () => {
    const { state } = type(atPressure(), "1201", whole);
    expect(state.pressureKpa).toBe(1);
  });
});

describe("applyKey at other granularities (FR-CFG-027)", () => {
  // At 0.1mm the last digit is the tenth: 134 reads 13.4. The ceiling rule is
  // unchanged — it is the value, not the digit count, that decides.
  it("reads the final digit as tenths", () => {
    const { state } = type(newEntryState(3), "134", tenths);
    expect(state.treads[0]).toBeCloseTo(13.4);
  });

  it("settles when a further tenth digit would pass the ceiling", () => {
    const { settled, state } = type(newEntryState(3), "45", tenths);
    expect(state.treads[0]).toBeCloseTo(4.5);
    expect(settled).toBe(true);
  });

  // At 0.5mm the driver types whole millimetres and one extra key adds the
  // half — no decimal point on a keypad used with gloves.
  it("adds a half and settles", () => {
    const { state } = type(newEntryState(3), "13", halves);
    const r = applyKey(state, { type: "half" }, halves);
    expect(r.state.treads[0]).toBeCloseTo(13.5);
    expect(r.settled).toBe(true);
  });

  it("ignores the half key where the granularity has no halves", () => {
    const { state } = type(newEntryState(3), "13", whole);
    const r = applyKey(state, { type: "half" }, whole);
    expect(r.state.treads[0]).toBe(13);
  });
});
