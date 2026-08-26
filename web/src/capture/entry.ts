// FR-INS-030 / FR-INS-031: hard ranges, rejected rather than warned. They are
// physical limits of the instrument, not tenant policy, which is why they are
// constants here and not configuration (CLAUDE.md rule 5 governs thresholds,
// and these are not thresholds — the database CHECKs carry the same two
// numbers).
const TREAD_CEILING_MM = 35;
const PRESSURE_CEILING_KPA = 1200;

export interface EntryOptions {
  treadReadingCount: number;
  granularityMm: number;
}

export interface EntryState {
  treads: (number | null)[];
  pressureKpa: number | null;
  // 0..count-1 are the tread fields, count is pressure. One index rather than
  // a tagged union because the keypad advances through them in a line.
  field: number;
  // Digits pressed for the focused field. Kept apart from the value so a
  // leading zero and a correction are both representable.
  buffer: string;
}

export type EntryKey =
  | { type: "digit"; digit: string }
  | { type: "half" }
  | { type: "delete" }
  | { type: "next" }
  | { type: "focus"; field: number };

export interface EntryResult {
  state: EntryState;
  // True when no further digit could change this field's value, so the caller
  // may advance without waiting for a tap. The caller owns the timing; a
  // reducer that scheduled its own would not be testable.
  settled: boolean;
}

export function newEntryState(treadReadingCount: number): EntryState {
  return {
    treads: Array<number | null>(treadReadingCount).fill(null),
    pressureKpa: null,
    field: 0,
    buffer: "",
  };
}

const isPressure = (state: EntryState, opts: EntryOptions) => state.field >= opts.treadReadingCount;

// At 0.1mm the last digit typed is the tenth, so the buffer is read as an
// integer number of tenths. At 1.0 and 0.5 the buffer is whole millimetres and
// the half arrives on its own key — there is no decimal point on this keypad.
function valueOf(buffer: string, state: EntryState, opts: EntryOptions): number {
  const n = parseInt(buffer, 10);
  if (isPressure(state, opts)) return n;
  return opts.granularityMm === 0.1 ? n / 10 : n;
}

const ceilingFor = (state: EntryState, opts: EntryOptions) =>
  isPressure(state, opts) ? PRESSURE_CEILING_KPA : TREAD_CEILING_MM;

function write(state: EntryState, buffer: string, opts: EntryOptions): EntryState {
  const value = buffer === "" ? null : valueOf(buffer, state, opts);
  if (isPressure(state, opts)) return { ...state, buffer, pressureKpa: value };
  const treads = [...state.treads];
  treads[state.field] = value;
  return { ...state, buffer, treads };
}

export function applyKey(state: EntryState, key: EntryKey, opts: EntryOptions): EntryResult {
  switch (key.type) {
    case "focus":
      return { state: { ...state, field: key.field, buffer: "" }, settled: false };

    case "next":
      return {
        state: {
          ...state,
          field: Math.min(state.field + 1, opts.treadReadingCount),
          buffer: "",
        },
        settled: false,
      };

    case "delete":
      return { state: write(state, "", opts), settled: false };

    case "half": {
      // Only meaningful at 0.5mm granularity, and only on a tread field.
      if (opts.granularityMm !== 0.5 || isPressure(state, opts)) {
        return { state, settled: false };
      }
      const current = state.treads[state.field];
      if (current === null) return { state, settled: false };
      const treads = [...state.treads];
      treads[state.field] = Math.floor(current) + 0.5;
      return { state: { ...state, treads, buffer: "" }, settled: true };
    }

    case "digit": {
      const ceiling = ceilingFor(state, opts);
      const grown = state.buffer + key.digit;
      // Past the ceiling, restart on the digit just pressed rather than
      // showing an error for a value that cannot exist — a mis-tap is far
      // more likely than an intention to enter 39mm.
      const buffer = valueOf(grown, state, opts) > ceiling ? key.digit : grown;
      const next = write(state, buffer, opts);
      // The whole auto-advance rule, in one line: could another digit still
      // change this answer? Appending "0" is the smallest possible growth, so
      // if even that overshoots, nothing can.
      const settled = valueOf(buffer + "0", state, opts) > ceiling;
      return { state: next, settled };
    }
  }
}
