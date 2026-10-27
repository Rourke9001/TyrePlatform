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

  // Settle rule: settle when another digit would exceed the ceiling. At
  // 1.0mm, 4-9 settle on the first press; 1-3 wait, since 10-35mm are real
  // readings.
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
  // driver just pressed, which is almost always what they meant.
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

  // 35mm is the valid ceiling, and the settle rule uses strict >, not >=.
  // After digit 3: 30 > 35 is false, so it waits. After digit 5: 35 > 35 is
  // false so the value is kept; then 350 > 35 is true so it settles.
  it("settles on 35mm at the ceiling without overflow", () => {
    const { state, settled } = type(newEntryState(3), "35", whole);
    expect(state.treads[0]).toBe(35);
    expect(settled).toBe(true);
  });

  // 36mm overflows the ceiling, so it restarts on the digit just pressed
  // (6), and the restart must itself settle: 60 > 35, so no further digit
  // could change 6mm, and a driver correcting a mistype should not also
  // have to tap next.
  it("restarts on 36mm just over the ceiling and settles on the restart", () => {
    const { state, settled } = type(newEntryState(3), "36", whole);
    expect(state.treads[0]).toBe(6);
    expect(settled).toBe(true);
  });

  // Guards the Math.min clamp in the next case: without it, advancing from
  // the pressure field would push field to 4, one past the last valid index,
  // and the next digit typed would write beyond the treads array.
  it("does not advance the field past pressure on next", () => {
    const atPressure = { ...newEntryState(3), field: 3 };
    const r = applyKey(atPressure, { type: "next" }, whole);
    expect(r.state.field).toBe(3);
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
  // digit and must not settle early. 1000 kPa is a real reading.
  it("waits for a fourth digit where one is still possible", () => {
    const { state, settled } = type(atPressure(), "120", whole);
    expect(state.pressureKpa).toBe(120);
    expect(settled).toBe(false);
  });

  it("accepts the four-digit value", () => {
    const { state } = type(atPressure(), "1000", whole);
    expect(state.pressureKpa).toBe(1000);
  });

  // FR-INS-031's ceiling is 1200 exactly. Reaching it requires the restart
  // comparison (grown > ceiling) to stay false at exactly 1200. A mutation
  // to >= here would treat 1200 as an overflow and wipe it back to 0 on the
  // fourth digit. The "waits for a fourth digit" test above pins the settle
  // half of the boundary; this test pins the restart half.
  it("reaches 1200 kPa exactly and settles on the fourth digit", () => {
    const { state, settled } = type(atPressure(), "1200", whole);
    expect(state.pressureKpa).toBe(1200);
    expect(settled).toBe(true);
  });

  // 1201 kPa overflows the ceiling, so it restarts on the digit just
  // pressed (1).
  it("restarts on 1201 kPa just over the ceiling", () => {
    const { state } = type(atPressure(), "1201", whole);
    expect(state.pressureKpa).toBe(1);
  });
});

describe("applyKey at other granularities (FR-CFG-027)", () => {
  // At 0.1mm the last digit is the tenth: 134 reads 13.4. The ceiling rule is
  // unchanged. It is the value, not the digit count, that decides.
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
  // half. There is no decimal point on a keypad used with gloves.
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

  // Guards the `current === null` check in the half case: without it,
  // Math.floor(null) coerces to 0 and the field is silently written 0.5, a
  // reading the driver never entered.
  it("ignores the half key on an empty tread field", () => {
    const r = applyKey(newEntryState(3), { type: "half" }, halves);
    expect(r.state.treads[0]).toBeNull();
    expect(r.settled).toBe(false);
  });

  // Guards the isPressure branch of the half case: without it, indexing
  // treads at the pressure index yields undefined, and Math.floor(undefined)
  // writes NaN past the array's end, discriminated by the settled
  // assertion, not the pressureKpa one.
  it("ignores the half key while focused on the pressure field", () => {
    const atPressure = { ...newEntryState(3), field: 3 };
    const r = applyKey(atPressure, { type: "half" }, halves);
    expect(r.state.pressureKpa).toBeNull();
    expect(r.settled).toBe(false);
  });
});

// U146, the owner's ruling of 27 Oct 2026: 13 settles at 0.5 mm, so the
// keypad moves on after the hold, and a half pressed straight after belongs
// to the cell it left. Not settled, so the sheet arms no second advance.
describe("the half key straight after the keypad moves on", () => {
  const thirteenThenNext = (opts: typeof whole) =>
    applyKey(type(newEntryState(3), "13", opts).state, { type: "next" }, opts).state;

  it("adds the half to the cell it left", () => {
    const r = applyKey(thirteenThenNext(halves), { type: "half" }, halves);
    expect(r.state.treads).toEqual([13.5, null, null]);
    expect(r.state.field).toBe(1);
    expect(r.settled).toBe(false);
  });

  it("adds it to the new cell once a digit lands there", () => {
    const typed = applyKey(thirteenThenNext(halves), { type: "digit", digit: "1" }, halves).state;
    const r = applyKey(typed, { type: "half" }, halves);
    expect(r.state.treads).toEqual([13, 1.5, null]);
  });

  it("does not reach back after a tap on another cell", () => {
    const tapped = applyKey(thirteenThenNext(halves), { type: "focus", field: 2 }, halves).state;
    const r = applyKey(tapped, { type: "half" }, halves);
    expect(r.state.treads).toEqual([13, null, null]);
  });

  it("does not reach back after a delete", () => {
    const cleared = applyKey(thirteenThenNext(halves), { type: "delete" }, halves).state;
    const r = applyKey(cleared, { type: "half" }, halves);
    expect(r.state.treads).toEqual([13, null, null]);
  });

  it("adds it to the last tread when the keypad moved on to pressure", () => {
    let s = applyKey(newEntryState(3), { type: "focus", field: 2 }, halves).state;
    s = applyKey(type(s, "13", halves).state, { type: "next" }, halves).state;
    expect(s.field).toBe(3);
    const r = applyKey(s, { type: "half" }, halves);
    expect(r.state.treads).toEqual([null, null, 13.5]);
    expect(r.state.pressureKpa).toBeNull();
    expect(r.state.field).toBe(3);
    expect(r.settled).toBe(false);
  });

  it.each([
    ["1.0", whole],
    ["0.1", tenths],
  ])("changes nothing at %s mm", (_, opts) => {
    const before = thirteenThenNext(opts);
    const r = applyKey(before, { type: "half" }, opts);
    expect(r.state.treads).toEqual(before.treads);
    expect(r.state.field).toBe(1);
  });

  it("leaves a cell that already holds its half", () => {
    const halved = applyKey(type(newEntryState(3), "13", halves).state, { type: "half" }, halves);
    const moved = applyKey(halved.state, { type: "next" }, halves).state;
    const r = applyKey(moved, { type: "half" }, halves);
    expect(r.state.treads).toEqual([13.5, null, null]);
    expect(r.state.field).toBe(1);
    expect(r.settled).toBe(false);
  });

  // A reopened position, or a correction pass, moves on onto a cell that
  // already holds a reading the driver has not touched yet.
  const reopened = () => ({ ...newEntryState(3), treads: [12, 12, 12], pressureKpa: 800 });

  it("reaches back over a cell that already holds a reading", () => {
    const moved = applyKey(type(reopened(), "13", halves).state, { type: "next" }, halves).state;
    const r = applyKey(moved, { type: "half" }, halves);
    expect(r.state.treads).toEqual([13.5, 12, 12]);
    expect(r.state.field).toBe(1);
    expect(r.settled).toBe(false);
  });

  it("adds it to that cell once the driver taps it", () => {
    const moved = applyKey(type(reopened(), "13", halves).state, { type: "next" }, halves).state;
    const tapped = applyKey(moved, { type: "focus", field: 1 }, halves).state;
    const r = applyKey(tapped, { type: "half" }, halves);
    expect(r.state.treads).toEqual([13, 12.5, 12]);
  });
});

// FR-INS-030: 35mm is the ceiling, and the database CHECK refuses 35.5
// (000001_init.up.sql), so the half key never makes it.
describe("the half key at the tread ceiling", () => {
  it("leaves 35 alone", () => {
    const r = applyKey(type(newEntryState(3), "35", halves).state, { type: "half" }, halves);
    expect(r.state.treads).toEqual([35, null, null]);
    expect(r.settled).toBe(false);
  });

  it("leaves 35 alone after the keypad moves on", () => {
    const moved = applyKey(type(newEntryState(3), "35", halves).state, { type: "next" }, halves);
    const r = applyKey(moved.state, { type: "half" }, halves);
    expect(r.state.treads).toEqual([35, null, null]);
    expect(r.state.field).toBe(1);
    expect(r.settled).toBe(false);
  });

  it("still adds the half to 34", () => {
    const r = applyKey(type(newEntryState(3), "34", halves).state, { type: "half" }, halves);
    expect(r.state.treads).toEqual([34.5, null, null]);
    expect(r.settled).toBe(true);
  });
});
