import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import {
  fetchSpares,
  type DashboardBody,
  type ForecastSummary,
  type InflationBand,
  type InflationCompliance,
  type SpareRow,
} from "../api/dashboard";
import { getDevTenantId } from "../api/devTenant";
import { sparesKey } from "../fleet/unit/queryKeys";
import { useTenantDate } from "../time/tenantTime";
import { BandChart } from "../ui/BandChart";
import { DataTable, type Column } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Panel } from "../ui/Panel";
import { StatTile } from "../ui/StatTile";
import {
  absenceLabel,
  formatCount,
  formatMm,
  formatPct,
  inflationBandLabel,
  judgedAtLabel,
  plural,
  pluralWord,
  treadSourceLabel,
  unavailableLabel,
} from "../ui/vocabulary";
import { withDepot } from "./dashboardParams";

interface DashboardPanelsProps {
  body: DashboardBody;
  depot?: string;
  depotFiltered: boolean;
}

const inflationColumns: Column<InflationBand>[] = [
  { key: "band", header: "Band", cell: (b) => inflationBandLabel(b.bandKey) },
  { key: "readings", header: "Readings", align: "right", cell: (b) => formatCount(b.readingCount) },
  { key: "tyres", header: "Tyres", align: "right", cell: (b) => formatCount(b.tyreCount) },
  {
    key: "share",
    header: "Share of classified",
    align: "right",
    cell: (b) =>
      b.pctOfClassified === null ? absenceLabel("unclassifiedShare") : formatPct(b.pctOfClassified),
  },
  { key: "cold", header: "Cold", align: "right", cell: (b) => formatCount(b.coldCount) },
  { key: "hot", header: "Hot", align: "right", cell: (b) => formatCount(b.hotCount) },
  {
    key: "unknown",
    header: "Unknown basis",
    align: "right",
    cell: (b) => formatCount(b.unknownCount),
  },
];

// U52: the window is the two dates the server chose, half-open as the API
// reads them, so the line says the end date is excluded.
function windowLine(
  inflation: InflationCompliance,
  formatDate: (date: string) => string,
): string | null {
  if (inflation.from === null || inflation.to === null) return null;
  const span = `${formatDate(inflation.from)} to ${formatDate(inflation.to)}. The end date is excluded.`;
  return inflation.windowDays === null
    ? `Chosen period: ${span}`
    : `Configured window: ${plural(inflation.windowDays, "day", "days")}, ${span}`;
}

// dashboard.go sends a null dueCount only with its reason beside it. A null
// with no reason is a server defect, surfaced as unknown rather than given
// a code the server never defined.
function forecastValue(forecast: ForecastSummary): string {
  if (forecast.dueCount !== null) return formatCount(forecast.dueCount);
  if (forecast.unavailable === null) return absenceLabel("unknown");
  return unavailableLabel(forecast.unavailable, false);
}

// FR-DSH-016: irregularWearSummaryJSON carries no rule code, so the tile
// names the rule its count answers to, FR-EXC-035, here and nowhere else.
const IRREGULAR_WEAR_RULE = "FR-EXC-035";

export function DashboardPanels({ body, depot, depotFiltered }: DashboardPanelsProps) {
  const {
    inflationCompliance: inflation,
    treadDistribution,
    removalForecast,
    irregularWear,
  } = body;
  const tenantKey = getDevTenantId() ?? "default";
  const formatDate = useTenantDate();
  const spares = useQuery({
    queryKey: sparesKey(tenantKey, depot),
    queryFn: () => fetchSpares(depot),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 0,
  });

  const spareColumns: Column<SpareRow>[] = [
    { key: "code", header: "Tyre", cell: (s) => s.displayCode },
    {
      key: "unit",
      header: "Unit",
      cell: (s) => <Link to={`/fleet/units/${s.vehicleId}`}>{s.fleetNumber}</Link>,
    },
    { key: "position", header: "Position", cell: (s) => s.positionCode },
    {
      key: "tread",
      header: "Tread",
      align: "right",
      cell: (s) =>
        s.currentTreadMm === null ? absenceLabel("unmeasured") : formatMm(s.currentTreadMm),
    },
    {
      key: "source",
      header: "Source",
      basis: true,
      cell: (s) =>
        s.measuredSource === null ? absenceLabel("unmeasured") : treadSourceLabel(s.measuredSource),
    },
    // The accepted mockup shows the day a spare was last measured, not the
    // time: a spare is judged on the tenant's calendar (FR-RPT-041).
    {
      key: "measured",
      header: "Last measured",
      cell: (s) =>
        s.lastMeasuredAt === null ? absenceLabel("neverMeasured") : formatDate(s.lastMeasuredAt),
    },
    {
      key: "age",
      header: "Age (days)",
      align: "right",
      cell: (s) => (s.ageDays === null ? absenceLabel("unknown") : formatCount(s.ageDays)),
    },
  ];

  const windowText = windowLine(inflation, formatDate);

  return (
    <>
      {/* FR-DSH-007: across the full width, since seven columns of per-band
          figures do not fit half a row. */}
      {/* U48: inflationComplianceJSON carries no judgedAt; its figures cover
          the window or period the line below names. */}
      <Panel id="inflation-panel" title="Inflation compliance" judged={judgedAtLabel("PERIOD")}>
        {inflation.unavailable ? (
          <p className="clock-note">{unavailableLabel(inflation.unavailable, depotFiltered)}</p>
        ) : (
          <>
            {windowText && <p className="clock-note">{windowText}</p>}
            <DataTable
              caption="Inflation compliance by band"
              columns={inflationColumns}
              rows={inflation.bands}
              rowKey={(b) => String(b.bandOrdinal)}
              empty={<EmptyState title={absenceLabel("noReadingsInPeriod")} />}
            />
          </>
        )}
      </Panel>

      <div className="panel-grid">
        {/* FR-DSH-008: the one chart; BandChart labels the bands from their
            bounds (U40) and turns to rows on a phone. */}
        {/* U48: treadBandJSON carries no judgedAt; the distribution is the
            register's current tread, so the page names today itself. */}
        <Panel id="bands-panel" title="Tread depth" judged={judgedAtLabel("TODAY")}>
          <BandChart title="Tread depth across running positions" bands={treadDistribution} />
        </Panel>
        {/* FR-DSH-009 and 016, read with the chart. Rule 5: a null horizon
            or spread is a configuration absence, never a 0. */}
        <div className="tile-stack">
          {/* The forecast list is a report (TYRE-6), so this tile has no
              link. */}
          <StatTile
            label="Replacement window opens"
            value={forecastValue(removalForecast)}
            qualifier={
              removalForecast.horizonDays === null
                ? undefined
                : `within ${plural(removalForecast.horizonDays, "day", "days")} of ${formatDate(removalForecast.from)}`
            }
            judged={judgedAtLabel(removalForecast.judgedAt)}
            requirement="FR-DSH-009"
          />
          <StatTile
            label="Irregular wear"
            value={
              irregularWear.spreadWarnMm === null
                ? absenceLabel("noSpreadConfigured")
                : formatCount(irregularWear.running)
            }
            qualifier={
              irregularWear.spreadWarnMm === null
                ? undefined
                : `${pluralWord(irregularWear.running, "running position", "running positions")} with a spread of ${formatMm(irregularWear.spreadWarnMm)} or more; ${plural(irregularWear.spare, "spare", "spares")} disclosed separately`
            }
            judged={judgedAtLabel(irregularWear.judgedAt)}
            to={withDepot(`/exceptions?rule=${IRREGULAR_WEAR_RULE}`, depot)}
            requirement="FR-DSH-016"
          />
        </div>
      </div>

      {/* FR-DSH-019: the spares list, never on a tread-ranked panel, on its
          own clock (U9) and its own query (U51). */}
      <Panel
        id="spares-panel"
        title="Spares"
        judged={spares.data ? judgedAtLabel(spares.data.judgedAt) : undefined}
      >
        {spares.isError ? (
          <p role="alert">The spares list did not load.</p>
        ) : (
          <DataTable
            caption="Spare tyres"
            columns={spareColumns}
            rows={spares.data?.spares ?? []}
            rowKey={(s) => s.tyreId}
            loading={spares.isPending}
            empty={
              <EmptyState title={absenceLabel("noSpares")}>
                {absenceLabel("noSparesBody")}
              </EmptyState>
            }
          />
        )}
      </Panel>
    </>
  );
}
