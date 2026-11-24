import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { ApiError, retryQuery } from "../../api/apiError";
import { getDevTenantId } from "../../api/devTenant";
import {
  fetchUnitCondition,
  fetchUnitInspection,
  fetchUnitInspections,
  voidInspection,
  type InspectionDetail,
} from "../../api/inspections";
import { useFormMutation } from "../useFormMutation";
import { voidedLocally } from "./inspection.view";
import {
  dashboardRefreshKeys,
  unitConditionKey,
  unitConditionPrefix,
  unitInspectionKey,
  unitInspectionPrefix,
  unitInspectionsKey,
  unitInspectionsPrefix,
  unitPrefix,
} from "./queryKeys";

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

// FR-INS-012. A void changes the list, the page and the condition of every
// unit the inspection read, so each is made stale by prefix, with the four
// keys the dashboard's Refresh invalidates, read again on their next visit.
// Nothing polls (U41). Of the unit reads, only the condition skips the
// refetch on focus; the list, the page and the unit take the fleet default.
export function useVoidInspection(inspectionId: string, onVoided: () => void) {
  const queryClient = useQueryClient();
  const tenantKey = getDevTenantId() ?? "default";
  const stale = [
    unitInspectionsPrefix(),
    unitInspectionPrefix(),
    unitPrefix(),
    unitConditionPrefix(),
    ...dashboardRefreshKeys(tenantKey),
  ];
  return useFormMutation<string, void>({
    mutate: async (reason) => {
      try {
        await voidInspection(inspectionId, reason);
      } catch (error) {
        // TY019 can mean it stands voided already, by a void of ours whose
        // answer was lost or by someone else's, so the same reads are made
        // stale and the page reads the void back; the refusal still shows.
        if (error instanceof ApiError && error.code === "TY019") {
          for (const queryKey of stale) void queryClient.invalidateQueries({ queryKey });
        }
        throw error;
      }
      // Each cached page of this inspection reads voided at once, so a page
      // whose refetch is slow or fails offers no second void (TY019).
      queryClient.setQueriesData<InspectionDetail>(
        {
          queryKey: unitInspectionPrefix(),
          predicate: (query) => query.queryKey[2] === inspectionId,
        },
        (detail) =>
          detail === undefined
            ? detail
            : { ...detail, inspection: voidedLocally(detail.inspection, reason) },
      );
    },
    invalidate: stale,
    onSuccess: onVoided,
  });
}
