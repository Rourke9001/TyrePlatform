import { useQuery } from "@tanstack/react-query";

import { apiGet } from "../api/client";
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

export function fetchCaptureContext(vehicleId: string): Promise<CaptureContext> {
  return apiGet<CaptureContext>(`/api/capture/vehicles/${vehicleId}`);
}

// staleTime Infinity, gcTime for the tab's life: FR-OFF-002 caches this for
// the session, refreshed by FR-OFF-003 on app-open/demand, never a timer
// that could change a threshold mid-walk-around. Options are a function,
// not inlined, because a rig (useQueries) and a solo unit must produce the
// same queryKey or the motive unit fetches twice.
export function captureContextQuery(vehicleId: string) {
  return {
    queryKey: ["capture-context", getDevTenantId() ?? "default", vehicleId],
    queryFn: () => fetchCaptureContext(vehicleId),
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
  };
}

export function useCaptureContext(vehicleId: string) {
  return useQuery(captureContextQuery(vehicleId));
}
