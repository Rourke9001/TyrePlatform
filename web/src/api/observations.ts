import { apiGet, apiPost } from "./client";

// Wire shape of the reconciliation surface. id is the WARNING's; resolving
// removes it from this list rather than mutating a field, since
// app.inspection_warning is append-only (DR-021).
export interface ReportedDifference {
  id: string;
  inspectionId: string;
  startedAt: string;
  submittedAt: string;
  driver: { id: string; displayName: string };
  rig: { id: string; motiveFleetNumber: string; members: string[] };
  observed: string[];
  removed: string[];
  // True once the offered rig has ended; applying is then refused
  // server-side (TY022 "stale"), never pre-checked here.
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
