// A fitment event can never be edited (rule 3), and CR-012 turns the pair
// of readings into distance, so a truncating parse would write a wrong
// reading no compensating event can fix: Number.parseInt reads "125 000"
// as 125, "125.7" as 125, "12a" as 12. capture/entry.ts's keypad hands
// digits it produced itself; this is a free-text field a manager types
// into.
export const ODOMETER_REFUSAL =
  "Enter the odometer in whole kilometres, digits only, no spaces, commas, decimal point or units.";

// FR-FIT-002: a unit with an odometer needs the reading on every fitment
// write, or 000025's trigger refuses the whole write. readOdometer("")
// reads a blank as "no value", so it's refused here, before the round trip.
export const ODOMETER_REQUIRED = "Enter the odometer: this unit needs a reading with every write.";

// An absent reading is valid (odometer is optional on the wire, and a unit
// without one never shows the field), which is why "no value" and "not a
// number" are different answers rather than one undefined.
export type OdometerReading = { ok: true; value: number | undefined } | { ok: false };

export function readOdometer(raw: string): OdometerReading {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: undefined };
  if (!/^\d+$/.test(trimmed)) return { ok: false };
  return { ok: true, value: Number(trimmed) };
}
