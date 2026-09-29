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
