// Every displayed count, percentage and tread measurement, written once so
// no page formats one itself (U55, web/CLAUDE.md).

import { groupThousands } from "./groupThousands";

// groupThousands takes an integer's digits, so a count or percentage is
// made whole first, rounding half away from zero as Intl.NumberFormat did.
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

// en-ZA's decimal separator is a comma in current ICU (Intl.NumberFormat
// would render "4,0 mm" beside formatMoney's "R16,537.50"), so tread uses
// toFixed and a point instead. A tread value on the wire is whole or half
// millimetres, the capture keypad has a half key and no decimal point, and
// the owner fixed the display at one decimal always (TYRE-238 comment 12938).
export function formatMm(n: number): string {
  return `${n.toFixed(1)} mm`;
}

// A percentage on the wire is a SQL column (pctOfGroup, pctOfClassified);
// this rounds for display and never computes one.
export function formatPct(n: number): string {
  return `${groupThousands(wholeDigits(n))}%`;
}
