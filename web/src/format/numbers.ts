// The manager screens' counts, percentages and tread measurements, written
// once (U55). Capture writes its own compact tread, as web/CLAUDE.md says.

import { groupThousands } from "./groupThousands";

// groupThousands takes an integer's digits, so a count or percentage is
// made whole first, rounding half away from zero.
function wholeDigits(n: number): string {
  return String(Math.sign(n) * Math.round(Math.abs(n)));
}

export function formatCount(n: number): string {
  return groupThousands(wholeDigits(n));
}

// The noun for a count that renders apart from it, as a tile's value does.
export function pluralWord(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function plural(n: number, one: string, many: string): string {
  return `${formatCount(n)} ${pluralWord(n, one, many)}`;
}

// One decimal with a point, never Intl's en-ZA decimal comma (TYRE-238
// comment 12938, web/CLAUDE.md).
export function formatMm(n: number): string {
  return `${n.toFixed(1)} mm`;
}

// A percentage on the wire is a SQL column (pctOfGroup, pctOfClassified);
// this rounds for display and never computes one.
export function formatPct(n: number): string {
  return `${groupThousands(wholeDigits(n))}%`;
}
