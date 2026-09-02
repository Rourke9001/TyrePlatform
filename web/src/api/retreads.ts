import { apiGet, apiPost } from "./client";

// Wire shapes of the retread queue (api/internal/httpapi/retreads.go,
// TYRE-93). Dispatching a casing to the retreader is what opens a job, and
// it lives on tyres.ts's dispatchTyre because a dispatch names a casing, not
// a job that does not exist yet (retreads.go's own comment).

// retreadJobJSON: one row of GET /api/retread-jobs?open=true. daysOut is
// computed against the tenant's own civil today (rule 6), never a browser
// clock.
export interface RetreadJob {
  id: string;
  tyreId: string;
  displayCode: string;
  depotName: string;
  sentAt: string;
  daysOut: number;
}

// fetchRetreadJobs is the retread queue read. open=true is always sent:
// listRetreadJobs refuses any other value of the query parameter, so there
// is no unfiltered variant to expose here.
export function fetchRetreadJobs(): Promise<RetreadJob[]> {
  return apiGet<RetreadJob[]>("/api/retread-jobs?open=true");
}

// retreadReturnRequest's body. casingAccepted stays a required boolean here:
// the server's own *bool exists to keep an omitted key from decoding into
// false, which SCRAPS the casing (retreads.go's own comment) — the form that
// builds this object is what must make the choice explicit, never a default.
export interface RetreadReturn {
  returnedOn: string;
  casingAccepted: boolean;
  reportReference: string;
  retreadCost?: string;
  postTreadMm?: string;
  casingValue?: string;
  newPatternId?: string;
}

// logRetreadReturn is FR-FIT-021/022's write, answering 204: the casing's
// re-rating off the new tread is app.log_retread_return's arithmetic alone
// (FR-VAL-006's own pin), never computed or inspected here.
export function logRetreadReturn(jobId: string, body: RetreadReturn): Promise<void> {
  return apiPost<void>(`/api/retread-jobs/${jobId}/return`, body);
}
