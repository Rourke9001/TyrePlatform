// An odometer reading rides on a fitment event, and a fitment event can never
// be edited — the app role holds no UPDATE or DELETE on it (CLAUDE.md rule 3),
// and CR-012 turns the pair of readings into the distance a tyre ran. A parse
// that truncates rather than refuses would write a wrong reading no
// compensating event can take back: Number.parseInt reads "125 000" as 125,
// "125.7" as 125 and "12a" as 12, each of them a plausible-looking number that
// is off by orders of magnitude.
//
// The driver's keypad hands capture/entry.ts digits it produced itself; this
// is a free-text field a manager types into, so the digits have to be checked
// here.
export const ODOMETER_REFUSAL =
  "Enter the odometer in whole kilometres, digits only — no spaces, decimal point or units.";

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
