import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { fetchDashboard, type DashboardBody } from "../api/dashboard";
import { getDevTenantId } from "../api/devTenant";
import { useActor } from "../auth/actorContext";
import { dashboardKey } from "../fleet/unit/queryKeys";
import { useTenantInstant } from "../time/tenantTime";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { PageHeader } from "../ui/PageHeader";
import { absenceLabel, plural } from "../ui/vocabulary";
import { DashboardFilters } from "./DashboardFilters";
import { DashboardPanels } from "./DashboardPanels";
import { DashboardTiles } from "./DashboardTiles";
import { readDashboardParams, writeDashboardParams } from "./dashboardParams";
import { ValueAtRiskHero } from "./ValueAtRiskHero";
import "./analytics.css";

// FR-DSH-001: the landing page for any ViewFleet actor.
export default function Dashboard() {
  const [search, setSearch] = useSearchParams();
  const params = readDashboardParams(search);
  const tenantKey = getDevTenantId() ?? "default";
  const queryClient = useQueryClient();
  const actor = useActor();
  const formatInstant = useTenantInstant();

  // U41: no polling, no refetch on focus and no retry, since the endpoint
  // costs seconds on a volume tenant (TYRE-256).
  const dashboard = useQuery({
    queryKey: dashboardKey(tenantKey, params),
    queryFn: () => fetchDashboard(params),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 0,
  });

  // FR-DSH-013: the button refetches every figure the page shows, the
  // spares list included, which U51 keeps a query of its own.
  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ["dashboard", tenantKey] });
    void queryClient.invalidateQueries({ queryKey: ["spares", tenantKey] });
    // H.3 criterion 6: the lists the tiles link to are marked stale too, so
    // the next visit refetches and never shows an older register than the
    // hero it was opened from.
    void queryClient.invalidateQueries({ queryKey: ["exceptions", tenantKey] });
    void queryClient.invalidateQueries({ queryKey: ["at-risk", tenantKey] });
  }

  function lede(body: DashboardBody): string {
    const parts = [`As at ${formatInstant(body.asAt)}`];
    if (actor) parts.push(actor.timezone);
    if (body.scope.level === "DEPOTS") {
      parts.push(`across your ${plural(body.scope.depotCount, "depot", "depots")}`);
    }
    return parts.join(", ");
  }

  return (
    <div className="dashboard">
      {/* The accepted mockup has no eyebrow: the shell's wordmark directly
          above already names the tenant. */}
      <PageHeader title="Dashboard" lede={dashboard.data ? lede(dashboard.data) : undefined} />
      <DashboardFilters
        params={params}
        onChange={(next) => setSearch(writeDashboardParams(next))}
        onRefresh={refresh}
        refreshing={dashboard.isFetching}
      />

      {dashboard.isPending && (
        <p className="dashboard-loading" role="status">
          Loading the dashboard.
        </p>
      )}

      {/* A failed fetch is this page's to explain. A render error belongs
          to RouteErrorBoundary around every route (U54). */}
      {dashboard.isError && (
        <div className="note-card" role="alert">
          <h2>The dashboard didn't load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <Button onClick={() => void dashboard.refetch()}>Retry</Button>
        </div>
      )}

      {dashboard.isSuccess && (
        <>
          <ValueAtRiskHero
            valueAtRisk={dashboard.data.valueAtRisk}
            belowThreshold={dashboard.data.belowThreshold}
            moneyVisible={dashboard.data.moneyVisible}
            depot={params.depot}
          />
          <DashboardTiles body={dashboard.data} depot={params.depot} />
          {/* U44, U87: "clear the depot filter" is true only for a
              tenant-wide actor who chose a depot. */}
          <DashboardPanels
            body={dashboard.data}
            depot={params.depot}
            depotFiltered={params.depot !== undefined && actor?.scope === "TENANT"}
          />
          {dashboard.data.estate.tyreCount === 0 && (
            <EmptyState title={absenceLabel("noTyres")} headingLevel={2}>
              {absenceLabel("noTyresBody")}
            </EmptyState>
          )}
        </>
      )}
    </div>
  );
}
