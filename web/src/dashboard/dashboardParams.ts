import type { DashboardParams } from "../api/dashboard";

// FR-DSH-011: the filter state is the URL, so a depot view is a link a
// manager can send. from and to travel together (U52): one without the
// other is dropped here, so no request carries the shape the API refuses.
export function readDashboardParams(search: URLSearchParams): DashboardParams {
  const params: DashboardParams = {};
  const depot = search.get("depot");
  const from = search.get("from");
  const to = search.get("to");
  if (depot) params.depot = depot;
  if (from && to) {
    params.from = from;
    params.to = to;
  }
  return params;
}

// A date field is sent once its value has held this long: typing a year
// changes it with every digit (U41, TYRE-256). Display timing, not a rule.
export const PERIOD_SETTLE_MS = 500;

export type SettledPeriod =
  | { kind: "set"; from: string; to: string }
  | { kind: "none" }
  | { kind: "wait"; misordered: boolean };

// A date input reports a year typed digit by digit as years 0002, 0020 and
// 0202, and takes a fifth digit, so only four digits with no leading zero
// are a whole year.
const WHOLE_DATE = /^[1-9]\d{3}-\d{2}-\d{2}$/;

// U52: what the two date fields ask the request to carry. Comparing two ISO
// dates as strings is ordering, not the date arithmetic U52 rules out.
export function settlePeriod(from: string, to: string): SettledPeriod {
  const fromWhole = WHOLE_DATE.test(from);
  const toWhole = WHOLE_DATE.test(to);
  if ((from === "" || fromWhole) && (to === "" || toWhole)) {
    if (!fromWhole || !toWhole) return { kind: "none" };
    return from < to ? { kind: "set", from, to } : { kind: "wait", misordered: true };
  }
  return { kind: "wait", misordered: false };
}

export function writeDashboardParams(params: DashboardParams): URLSearchParams {
  const search = new URLSearchParams();
  if (params.depot) search.set("depot", params.depot);
  if (params.from && params.to) {
    search.set("from", params.from);
    search.set("to", params.to);
  }
  return search;
}

// U17: a tile and the list it links to count the same units, so a link off
// a depot view carries the depot, and a list that cannot narrow to a depot
// is not linked from a depot view.
export function withDepot(path: string, depot?: string): string {
  if (!depot) return path;
  return `${path}${path.includes("?") ? "&" : "?"}depot=${encodeURIComponent(depot)}`;
}
