import { apiGet, apiPost } from "./client";

// Wire shapes of the reconciliation surface
// (api/internal/httpapi/observations.go). The id is the WARNING's: until a
// report is resolved there is no other row to name it by, which is also why
// resolving one removes it from this list rather than changing a field on it
// (app.inspection_warning is append-only, DR-021).
export interface ReportedDifference {
  id: string;
  inspectionId: string;
  startedAt: string;
  submittedAt: string;
  driver: { id: string; displayName: string };
  rig: { id: string; motiveFleetNumber: string; members: string[] };
  observed: string[];
  removed: string[];
  // The offered rig has ended, so applying can only be refused (TY022
  // "stale"). The server decides this, not the browser: a rig ended between
  // the fetch and the click is still a refusal the screen renders.
  stale: boolean;
}

export function fetchReportedDifferences(): Promise<ReportedDifference[]> {
  return apiGet<ReportedDifference[]>("/api/combinations/observations");
}

// The resulting rig is null when the driver reported the motive uncoupled
// from everything: the rig ends and none opens (U10 declines a one-member
// rig). Either way the rig list is stale, so the caller invalidates it.
export function applyReportedDifference(
  id: string,
  body: { note?: string },
): Promise<{ resultingRigId: string | null }> {
  return apiPost<{ resultingRigId: string | null }>(
    `/api/combinations/observations/${id}/apply`,
    body,
  );
}

// The note is required and that rule is the database's (TY022 "a dismissal
// carries a reason"); the form disables the button, which is a convenience
// and never the boundary (NFR-SEC-006).
export function dismissReportedDifference(id: string, body: { note: string }): Promise<void> {
  return apiPost<void>(`/api/combinations/observations/${id}/dismiss`, body);
}
