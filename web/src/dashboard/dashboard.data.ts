import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  fetchDashboard,
  fetchExceptions,
  fetchSpares,
  type DashboardParams,
  type ExceptionsParams,
} from "../api/dashboard";
import { getDevTenantId } from "../api/devTenant";
import { fetchDepots } from "../api/units";
import { dashboardKey, depotsKey, exceptionsKey, sparesKey } from "../fleet/unit/queryKeys";

// The queries the overview, exceptions and at-risk pages read through
// (ADR-0022). Each key, staleness and retry is the page's own contract with
// FR-DSH-013 and U41, so a screen never sets one itself.

function tenantKey(): string {
  return getDevTenantId() ?? "default";
}

// U41: no polling, no refetch on focus and no retry, since the endpoint
// costs seconds on a volume tenant (TYRE-256).
export function useDashboard(params: DashboardParams) {
  return useQuery({
    queryKey: dashboardKey(tenantKey(), params),
    queryFn: () => fetchDashboard(params),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 0,
  });
}

// FR-DSH-013: the button refetches every figure the page shows, the spares
// list included, which U51 keeps a query of its own.
export function useRefreshDashboard(): () => void {
  const queryClient = useQueryClient();
  const key = tenantKey();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ["dashboard", key] });
    void queryClient.invalidateQueries({ queryKey: ["spares", key] });
    // H.3 criterion 6: the lists the tiles link to are marked stale too, so
    // the next visit refetches and never shows an older register than the
    // hero it was opened from.
    void queryClient.invalidateQueries({ queryKey: ["exceptions", key] });
    void queryClient.invalidateQueries({ queryKey: ["at-risk", key] });
  };
}

// FR-DSH-019: on its own clock (U9) and its own query (U51).
export function useSpares(depot?: string) {
  return useQuery({
    queryKey: sparesKey(tenantKey(), depot),
    queryFn: () => fetchSpares(depot),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 0,
  });
}

export function useDepots() {
  return useQuery({ queryKey: depotsKey(tenantKey()), queryFn: () => fetchDepots() });
}

// A depot view names its depot; the depots query shares the dashboard's
// cache entry, and runs only when there is a depot to name.
export function useDepotName(depot: string | undefined): string | undefined {
  const depots = useQuery({
    queryKey: depotsKey(tenantKey()),
    queryFn: () => fetchDepots(),
    enabled: depot !== undefined,
  });
  return depots.data?.find((d) => d.id === depot)?.name;
}

// U18: judged as inspected, refetched by its own Refresh (FR-DSH-013).
export function useExceptions(params: ExceptionsParams) {
  return useQuery({
    queryKey: exceptionsKey(tenantKey(), params),
    queryFn: () => fetchExceptions(params),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 0,
  });
}
