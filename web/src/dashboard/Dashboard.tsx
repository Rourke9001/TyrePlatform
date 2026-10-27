// The Radix depot picker's look; the rest of the page is Tread's.
import "../ui/legacy/ui.css";
import { useSearchParams } from "react-router";

import { useActor } from "../auth/actorContext";
import { absenceLabel } from "../domain/vocabulary";
import { useTenantInstant } from "../time/tenantTime";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { PageHeader } from "../ui/PageHeader";
import { useDashboard, useRefreshDashboard } from "./dashboard.data";
import { dashboardLede } from "./dashboard.view";
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
  const actor = useActor();
  const formatInstant = useTenantInstant();
  const dashboard = useDashboard(params);
  const refresh = useRefreshDashboard();

  return (
    <div className="dashboard">
      <PageHeader
        title="Dashboard"
        description={
          dashboard.data ? dashboardLede(dashboard.data, actor?.timezone, formatInstant) : undefined
        }
      />
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
        <Banner
          tone="warning"
          title={<h2 className="load-failure__title">The dashboard didn't load</h2>}
          action={<Button onClick={() => void dashboard.refetch()}>Retry</Button>}
        >
          The server could not be reached. Check your connection, then retry.
        </Banner>
      )}

      {dashboard.isSuccess && (
        <div className="overview-grid">
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
            <EmptyState title={absenceLabel("noTyres")} headingLevel={2} className="overview-wide">
              {absenceLabel("noTyresBody")}
            </EmptyState>
          )}
        </div>
      )}
    </div>
  );
}
