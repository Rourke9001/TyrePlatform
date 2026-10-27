// FR-INS-030/FR-INS-031: hard physical ranges, rejected not warned, so they are
// constants here, not tenant configuration (rule 5); the database CHECKs
// carry the same numbers.
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
  // U146: the tread field the last next left, armed only when this visit
  // typed into or halved it, so a half pressed straight after can still
  // reach it. A half keeps it; a digit, delete or focus clears it.
  advancedFrom: number | null;
  // U146: the focused field holds a digit or a half from this visit, which
  // is what lets next arm advancedFrom.
  touched: boolean;
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
    advancedFrom: null,
    touched: false,
  };
}

const isPressure = (state: EntryState, opts: EntryOptions) => state.field >= opts.treadReadingCount;

// At 0.1mm the last digit typed is the tenth, so the buffer is read as an
// integer number of tenths. At 1.0 and 0.5 the buffer is whole millimetres and
// the half arrives on its own key. There is no decimal point on this keypad.
function valueOf(buffer: string, state: EntryState, opts: EntryOptions): number {
  const n = parseInt(buffer, 10);
  if (isPressure(state, opts)) return n;
  return opts.granularityMm === 0.1 ? n / 10 : n;
}

const ceilingFor = (state: EntryState, opts: EntryOptions) =>
  isPressure(state, opts) ? PRESSURE_CEILING_KPA : TREAD_CEILING_MM;

function write(state: EntryState, buffer: string, opts: EntryOptions): EntryState {
  const value = buffer === "" ? null : valueOf(buffer, state, opts);
  const touched = buffer !== "";
  if (isPressure(state, opts)) {
    return { ...state, buffer, pressureKpa: value, advancedFrom: null, touched };
  }
  const treads = [...state.treads];
  treads[state.field] = value;
  return { ...state, buffer, treads, advancedFrom: null, touched };
}

// FR-INS-030: a half that would pass the ceiling changes nothing, since the
// CHECK at db/migrations/000001_init.up.sql:368 would refuse the reading.
const halfPassesCeiling = (mm: number) => Math.floor(mm) + 0.5 > TREAD_CEILING_MM;

export function applyKey(state: EntryState, key: EntryKey, opts: EntryOptions): EntryResult {
  switch (key.type) {
    case "focus":
      return {
        state: { ...state, field: key.field, buffer: "", advancedFrom: null, touched: false },
        settled: false,
      };

    case "next":
      return {
        state: {
          ...state,
          field: Math.min(state.field + 1, opts.treadReadingCount),
          buffer: "",
          advancedFrom: state.touched && !isPressure(state, opts) ? state.field : null,
          touched: false,
        },
        settled: false,
      };

    case "delete":
      return { state: write(state, "", opts), settled: false };

    case "half": {
      // U145: the half key is a 0.5mm tenant's, and it only ever adds to a tread.
      if (opts.granularityMm !== 0.5) return { state, settled: false };
      const from = state.advancedFrom;
      // U146, the owner's ruling of 27 Oct 2026: after next, every half until
      // another key belongs to the whole reading the keypad left, never to the
      // field it moved on to, so a double tap finds it at x.5 and stops. Not
      // settled, so the sheet arms no second advance.
      if (from !== null) {
        const left = state.treads[from];
        if (left === null || !Number.isInteger(left) || halfPassesCeiling(left)) {
          return { state, settled: false };
        }
        const treads = [...state.treads];
        treads[from] = left + 0.5;
        return { state: { ...state, treads }, settled: false };
      }
      if (isPressure(state, opts)) return { state, settled: false };
      const current = state.treads[state.field];
      if (current === null || halfPassesCeiling(current)) return { state, settled: false };
      const treads = [...state.treads];
      treads[state.field] = Math.floor(current) + 0.5;
      return { state: { ...state, treads, buffer: "", touched: true }, settled: true };
    }

    case "digit": {
      const ceiling = ceilingFor(state, opts);
      const grown = state.buffer + key.digit;
      // Past the ceiling, restart on the digit just pressed rather than
      // showing an error for a value that cannot exist. A mis-tap is far
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
