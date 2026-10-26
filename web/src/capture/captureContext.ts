import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { apiGet } from "../api/client";
import { retryQuery } from "../api/apiError";
import { getDevTenantId } from "../api/devTenant";

// Wire shape of GET /api/capture/vehicles/{id}. Every field exists because
// FR-OFF-001 takes connectivity away after this call returns: a missing
// input is a warning that silently never fires.
export interface CapturePosition {
  id: string;
  vehicleId: string;
  code: string;
  sequence: number;
  axleClass: string;
  axleType: string;
  // FR-INS-029a: the server maps entry order to OUTER/CENTRE/INNER by this
  // side. Served so the sheet can draw the same frame (TYRE-147). Null on a
  // spare.
  side: "LEFT" | "RIGHT" | null;
  // Null on a spare, which has no axle. The diagram groups running positions
  // by (vehicleId, axleNumber) and draws spares separately.
  axleNumber: number | null;
  isSpare: boolean;
  unitLabel: string | null;
  tyreId: string | null;
  tyreCode: string | null;
  // FR-INS-034: the increase and the fitment that would excuse it.
  previousGoverningMm: number | null;
  previousReadingAt: string | null;
  // FR-TYR-017: days since previousReadingAt in the tenant's calendar.
  // Optional: the capture route must render against an API older than
  // the field, which then reads as absent.
  previousReadingAgeDays?: number | null;
  fitmentSincePrevious: boolean;
  // FR-INS-037 / FR-INS-031a. Null on a spare: FR-CFG-013 as amended gives
  // SPARE no target, and an unclassified spare pressure is deliberate.
  targetKpa: number | null;
  warnUnderPct: number | null;
  criticalUnderPct: number | null;
  warnOverPct: number | null;
  criticalOverPct: number | null;
}

export interface CaptureConfig {
  treadReadingCount: number;
  // FR-CFG-027, stamped onto every reading (FR-INS-021).
  treadGranularityMm: number;
  widthSpreadWarnMm: number;
  odometerMaxDailyKm: number;
  wearRateAlertMultiple: number;
  removalThresholdMm: number;
  // TYRE-155, rule 5: whether the sheet carries a spare cell at all. Owner
  // default true (FR-INS-066 is a Must); the right answer for a real fleet
  // is unknown, so it is served, never assumed.
  captureSpares: boolean;
}

// FR-INS-062: the rig a CONTROLLER set, for the driver to confirm before
// starting. The driver never composes it. Managing what is coupled to
// what is fleet configuration, and it is set before the truck leaves.
export interface CaptureMember {
  vehicleId: string;
  fleetNumber: string;
  sequence: number;
  descriptor: string | null;
}

export interface CaptureCombination {
  id: string;
  members: CaptureMember[];
}

export interface CaptureContext {
  vehicleId: string;
  fleetNumber: string;
  registration: string | null;
  // HORSE / TRAILER / RIGID / LIGHT. A trailer has no odometer field at all
  // (FR-INS-020) and distance is never apportioned to one (FR-INS-064).
  unitKind: string;
  lastOdometerKm: number | null;
  // FR-INS-033 divides by the gap since this date; the value alone has no
  // denominator.
  lastOdometerAt: string | null;
  // FR-INS-020's pre-fill projects from the last reading at this rate. Null
  // when the timeline cannot support one (a first inspection, or two
  // readings the same day); see history.projectedOdometerKm.
  averageDailyKm: number | null;
  positions: CapturePosition[];
  // Null unless this unit heads a current combination: a solo rigid, or a
  // trailer asked for its own context, simply has none.
  combination: CaptureCombination | null;
  config: CaptureConfig;
  // Keyed "AXLE_CLASS:AXLE_TYPE" (BR-ANL-006 cohorts by class, BR-ANL-009
  // forbids blending types). A missing key means no rate is asserted, which
  // for a LIFTING axle is correct, not a gap.
  cohortWearRateMmPerMonth: Record<string, number>;
}

// startedAt is a resumed draft's own: the server then admits a unit the
// driver could capture at some instant of the draft's submit window, so a
// trip that ended while the draft sat on the phone does not strand it (U148,
// rule 7). A fresh capture sends none and is read at now (FR-AUT-005).
export function fetchCaptureContext(
  vehicleId: string,
  startedAt?: string,
): Promise<CaptureContext> {
  const query = startedAt === undefined ? "" : `?startedAt=${encodeURIComponent(startedAt)}`;
  return apiGet<CaptureContext>(`/api/capture/vehicles/${vehicleId}${query}`);
}

// staleTime Infinity, gcTime for the tab's life: FR-OFF-002 caches this for
// the session, refreshed by FR-OFF-003 on app-open/demand, never a timer
// that could change a threshold mid-walk-around. Options are a function,
// not inlined, because a rig (useQueries) and a solo unit must produce the
// same queryKey or the motive unit fetches twice. The key carries startedAt
// because a read through a draft's window answers for that window, not now.
//
// A windowed read is seeded from the entry this capture started on (FR-OFF-001,
// U148): a remount keys on the draft's startedAt, which the first mount never
// cached, and offline a query with no data does not fetch. The seed admits
// nothing the first mount did not, and the submit is judged again over its own
// window.
export function captureContextQuery(vehicleId: string, startedAt?: string, seed?: QueryClient) {
  return {
    queryKey: ["capture-context", getDevTenantId() ?? "default", vehicleId, startedAt ?? null],
    queryFn: () => fetchCaptureContext(vehicleId, startedAt),
    initialData:
      startedAt === undefined || !seed
        ? undefined
        : () => seed.getQueryData<CaptureContext>(captureContextQuery(vehicleId).queryKey),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: retryQuery,
  };
}

export function useCaptureContext(vehicleId: string, startedAt?: string, enabled = true) {
  const client = useQueryClient();
  return useQuery({ ...captureContextQuery(vehicleId, startedAt, client), enabled });
}
