import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { ApiError, retryQuery } from "../../api/apiError";
import {
  fetchUnitCondition,
  fetchUnitInspection,
  fetchUnitInspections,
} from "../../api/inspections";
import { unitConditionKey, unitInspectionKey, unitInspectionsKey } from "./queryKeys";

// The unit's inspection reads (TYRE-325, ADR-0022). Each keeps the
// QueryClient's default freshness, stale on mount as the unit read is, and
// nothing polls (U41, spec Lead's call 21).

export function useUnitInspections(unitId: string) {
  return useInfiniteQuery({
    queryKey: unitInspectionsKey(unitId),
    queryFn: ({ pageParam }) => fetchUnitInspections(unitId, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextAfter,
  });
}

// A 404 answers the same next time: the inspection is not on this unit.
export function useUnitInspection(unitId: string, inspectionId: string) {
  return useQuery({
    queryKey: unitInspectionKey(unitId, inspectionId),
    queryFn: () => fetchUnitInspection(unitId, inspectionId),
    retry: (failures, error) =>
      !(error instanceof ApiError && error.status === 404) && retryQuery(failures, error),
  });
}

// No refetch on focus: the exceptions read builds the whole tenant's latest
// readings before it filters to the unit, the cost U41 keeps off a focus
// event (spec section 3, dashboard.data.ts).
export function useUnitCondition(unitId: string) {
  return useQuery({
    queryKey: unitConditionKey(unitId),
    queryFn: () => fetchUnitCondition(unitId),
    refetchOnWindowFocus: false,
  });
}
