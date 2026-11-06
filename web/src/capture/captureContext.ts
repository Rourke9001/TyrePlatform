import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { apiGet } from "../api/client";
import { retryQuery } from "../api/apiError";
import { getDevTenantId } from "../api/devTenant";
import { useActor } from "../auth/actorContext";
import { tenantDayKey } from "../time/tenantTime";

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
  lastOdometerAt: string | null;
  // Days since lastOdometerAt in the tenant's calendar (rule 6, TYRE-342),
  // counted by the server so no phone clock sets it. FR-INS-020 projects
  // over it. Optional for the reason previousReadingAgeDays is.
  lastOdometerAgeDays?: number | null;
  // FR-INS-033's base: the last reading on a day before the tenant's today,
  // which DR-020's trigger judges against (000021), and its age, so at least
  // one day. Null when no reading predates today; optional as above.
  odometerBaseKm?: number | null;
  odometerBaseAgeDays?: number | null;
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

function captureContextKey(vehicleId: string, startedAt?: string) {
  return ["capture-context", getDevTenantId() ?? "default", vehicleId, startedAt ?? null];
}

// gcTime for the tab's life (FR-OFF-002), so an entry nothing observes stays,
// such as the at-now copy across a route change or a draft's window across a
// remount.
// A read at now is fresh for the tenant's day it was fetched on, since its day
// counts are that day's (rule 6, U179).
// A failed or paused renewal keeps the copy (U179).
// A draft's windowed read does not go stale with time, since it answers for
// the window its submit is judged over (U148, U182).
// Past the start screen, the walk-around and the review read held contexts,
// not this query (U186).
// One function for a rig (useQueries) and a solo unit, or their keys differ
// and the motive fetches twice (FR-OFF-001).
// A windowed read with no data of its own is seeded from the at-now entry,
// since offline its own fetch pauses (FR-OFF-001, U148).
// The seed admits no unit the first mount did not, and the submit is judged
// again over its own window (U148).
export function captureContextQuery(
  vehicleId: string,
  startedAt?: string,
  seed?: QueryClient,
  timeZone = "UTC",
) {
  const queryKey = captureContextKey(vehicleId, startedAt);
  return {
    queryKey,
    queryFn: () => fetchCaptureContext(vehicleId, startedAt),
    initialData:
      startedAt === undefined || !seed
        ? undefined
        : () => seed.getQueryData<CaptureContext>(captureContextKey(vehicleId)),
    staleTime:
      startedAt !== undefined
        ? Infinity
        : (query: { state: { dataUpdatedAt: number } }) =>
            tenantDayKey(query.state.dataUpdatedAt, timeZone) === tenantDayKey(Date.now(), timeZone)
              ? Infinity
              : 0,
    gcTime: Infinity,
    // A renewal with a copy in hand tries once, since each retry holds the
    // start screen on Loading over the copy it falls back to (U179).
    retry: (failures: number, error: unknown) =>
      seed?.getQueryData(queryKey) === undefined && retryQuery(failures, error),
  };
}

export function useCaptureContext(vehicleId: string, startedAt?: string, enabled = true) {
  const client = useQueryClient();
  const timeZone = useActor()?.timezone ?? "UTC";
  return useQuery({ ...captureContextQuery(vehicleId, startedAt, client, timeZone), enabled });
}
