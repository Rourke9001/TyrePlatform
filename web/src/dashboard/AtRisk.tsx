import { Link, useSearchParams } from "react-router";

import { useActor } from "../auth/actorContext";
import { absenceLabel } from "../domain/vocabulary";
import { useTenantInstant } from "../time/tenantTime";
import { Banner } from "../ui/Banner";
import { Card } from "../ui/Card";
import { DataTable, type Column } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Metric } from "../ui/Metric";
import { PageHeader } from "../ui/PageHeader";
import { atRiskClassView, atRiskLede, atRiskRows, type AtRiskRowView } from "./atRisk.view";
import { useAtRisk, useDepotName } from "./dashboard.data";
import { readDashboardParams } from "./dashboardParams";
import { FilterBar } from "./FilterBar";
import { useMoneyText } from "./useMoneyText";
import "./analytics.css";

// FR-DSH-017, U47: every tyre at or below the removal threshold today
// (atRisk.view.ts says what each figure holds).
export default function AtRisk() {
  const [search] = useSearchParams();
  const depot = readDashboardParams(search).depot;
  const actor = useActor();
  const money = useMoneyText();
  const formatInstant = useTenantInstant();
  const list = useAtRisk(depot);
  const depotName = useDepotName(depot);

  const columns: Column<AtRiskRowView>[] = [
    { key: "code", header: "Tyre", mono: true, nowrap: true, render: (t) => t.code },
    {
      key: "unit",
      header: "Unit",
      nowrap: true,
      render: (t) => <Link to={`/fleet/units/${t.vehicleId}`}>{t.fleetNumber}</Link>,
    },
    { key: "position", header: "Position", mono: true, render: (t) => t.position },
    {
      key: "tread",
      header: "Tread against threshold",
      align: "right",
      mono: true,
      render: (t) => t.tread,
    },
    { key: "source", header: "Tread source", basis: true, render: (t) => t.source },
    { key: "read", header: "Read at", render: (t) => t.read },
    {
      key: "value",
      header: "Casing value",
      align: "right",
      mono: true,
      render: (t) => money.figure(t.value),
    },
    { key: "basis", header: "Basis", basis: true, render: (t) => t.basis },
  ];

  const running = list.data ? atRiskClassView(list.data.running) : undefined;
  const spare = list.data ? atRiskClassView(list.data.spare) : undefined;

  return (
    <div className="analytics-page">
      <PageHeader
        title="Value at risk"
        description={list.data ? atRiskLede(list.data.judgedAt, depot, depotName) : undefined}
      />
      {/* FR-DSH-013: the list's one refetch, as on /exceptions; it has no
          filters of its own. */}
      <FilterBar onRefresh={() => void list.refetch()} refreshing={list.isFetching} />
      {running && spare && (
        <div className="tile-grid">
          <Metric
            label="Running"
            value={money.figure(running.value)}
            detail={running.detail}
            headingLevel={2}
            data-requirement="FR-RPT-040"
          />
          <Metric
            label="Spares"
            value={money.figure(spare.value)}
            detail={spare.detail}
            headingLevel={2}
          />
        </div>
      )}
      {list.isError ? (
        <Banner tone="warning" title="The at-risk list did not load." />
      ) : (
        <Card padding="none">
          <DataTable
            caption="Tyres at or below the removal threshold"
            columns={columns}
            rows={list.data ? atRiskRows(list.data.tyres, formatInstant) : []}
            rowKey={(t) => t.key}
            loading={list.isPending}
            cardHeadingLevel={2}
            empty={
              <EmptyState title={absenceLabel("noTyresAtRisk")} headingLevel={2}>
                {absenceLabel("noTyresAtRiskBody")}
              </EmptyState>
            }
          />
        </Card>
      )}
      {/* Rule 6: every time above is the tenant's, named once, here, as
          /exceptions names it. */}
      <p className="clock-note">Times are {actor?.timezone ?? "UTC"}.</p>
    </div>
  );
}
