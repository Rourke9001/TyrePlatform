import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { fetchAtRisk, type AtRiskClass, type TyreAtRisk } from "../api/dashboard";
import { getDevTenantId } from "../api/devTenant";
import { moneyOrEmpty, moneyText } from "../api/money";
import { fetchDepots } from "../api/units";
import { useActor } from "../auth/actorContext";
import { atRiskKey, depotsKey } from "../fleet/unit/queryKeys";
import { useTenantInstant } from "../time/tenantTime";
import { DataTable, type Column } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { FilterBar } from "../ui/FilterBar";
import { PageHeader } from "../ui/PageHeader";
import { StatTile } from "../ui/StatTile";
import {
  absenceLabel,
  basisLabel,
  formatCount,
  formatMm,
  judgedAtLabel,
  plural,
  treadSourceLabel,
} from "../ui/vocabulary";
import "./analytics.css";

// U47: the hero's own words for the same breakdown, so the figure and the
// list it opens read alike.
function classQualifier(c: AtRiskClass): string {
  return `${plural(c.tyreCount, "tyre", "tyres")}: ${formatCount(c.actualCount)} at actual cost, ${formatCount(c.estimatedOrAuditCount)} estimated or audit, of which ${formatCount(c.auditCount)} audit; ${formatCount(c.unvaluedCount)} unvalued`;
}

function classValue(c: AtRiskClass): string {
  return moneyOrEmpty(c.casingValueAtRisk, true, c.tyreCount, absenceLabel("noneAtRisk"));
}

// FR-DSH-017, U47: every tyre at or below the removal threshold today, with
// its casing value and the basis it was priced on (ADR-0010, TYRE-176). The
// route is gated on ViewValuation (routes.tsx), so money is visible here by
// construction; a null is an empty class or an unvalued one (U36).
export default function AtRisk() {
  const [search] = useSearchParams();
  const depot = search.get("depot") ?? undefined;
  const tenantKey = getDevTenantId() ?? "default";
  const actor = useActor();
  const formatInstant = useTenantInstant();
  const list = useQuery({
    queryKey: atRiskKey(tenantKey, depot),
    queryFn: () => fetchAtRisk(depot),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  // A depot view names its depot; the list shares the dashboard's cache entry.
  const depots = useQuery({
    queryKey: depotsKey(tenantKey),
    queryFn: () => fetchDepots(),
    enabled: depot !== undefined,
  });
  const depotName = depots.data?.find((d) => d.id === depot)?.name;

  const columns: Column<TyreAtRisk>[] = [
    { key: "code", header: "Tyre", cell: (t) => t.displayCode },
    {
      key: "unit",
      header: "Unit",
      cell: (t) => <Link to={`/fleet/units/${t.vehicleId}`}>{t.fleetNumber}</Link>,
    },
    { key: "position", header: "Position", cell: (t) => t.positionCode },
    {
      key: "tread",
      header: "Tread against threshold",
      align: "right",
      cell: (t) => `${formatMm(t.currentTreadMm)} of ${formatMm(t.removalThresholdMm)}`,
    },
    {
      key: "source",
      header: "Tread source",
      basis: true,
      cell: (t) => treadSourceLabel(t.treadSource),
    },
    {
      key: "read",
      header: "Read at",
      cell: (t) => (t.readAt === null ? absenceLabel("undated") : formatInstant(t.readAt)),
    },
    {
      key: "value",
      header: "Casing value",
      align: "right",
      cell: (t) => moneyText(t.casingValue, true),
    },
    { key: "basis", header: "Basis", basis: true, cell: (t) => basisLabel(t.casingBasis) },
  ];

  const lede = list.data
    ? [
        `Tyres at or below the removal threshold, judged ${judgedAtLabel(list.data.judgedAt)}`,
        depot === undefined ? undefined : `at ${depotName ?? absenceLabel("unnamedDepot")}`,
      ]
        .filter((part) => part !== undefined)
        .join(", ")
    : undefined;

  return (
    <div className="analytics-page">
      <PageHeader title="Value at risk" lede={lede} />
      {/* FR-DSH-013: the list's one refetch, as on /exceptions; it has no
          filters of its own. */}
      <FilterBar onRefresh={() => void list.refetch()} refreshing={list.isFetching} />
      {list.data && (
        <div className="tile-grid">
          <StatTile
            label="Running"
            value={classValue(list.data.running)}
            qualifier={classQualifier(list.data.running)}
            requirement="FR-RPT-040"
            headingLevel={2}
          />
          <StatTile
            label="Spares"
            value={classValue(list.data.spare)}
            qualifier={classQualifier(list.data.spare)}
            headingLevel={2}
          />
        </div>
      )}
      {list.isError ? (
        <p role="alert">The at-risk list did not load.</p>
      ) : (
        <DataTable
          caption="Tyres at or below the removal threshold"
          columns={columns}
          rows={list.data?.tyres ?? []}
          rowKey={(t) => t.tyreId}
          loading={list.isPending}
          cardHeadingLevel={2}
          empty={
            <EmptyState title={absenceLabel("noTyresAtRisk")} headingLevel={2}>
              {absenceLabel("noTyresAtRiskBody")}
            </EmptyState>
          }
        />
      )}
      {/* Rule 6: every time above is the tenant's, named once, here, as
          /exceptions names it. */}
      <p className="clock-note">Times are {actor?.timezone ?? "UTC"}.</p>
    </div>
  );
}
