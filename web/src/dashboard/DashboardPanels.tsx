import { Link } from "react-router";

import type { DashboardBody } from "../api/dashboard";
import { absenceLabel, judgedAtLabel } from "../domain/vocabulary";
import { useTenantDate } from "../time/tenantTime";
import { Banner } from "../ui/Banner";
import { BandChart } from "../ui/BandChart";
import { Card } from "../ui/Card";
import { DataTable, type Column } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Metric } from "../ui/Metric";
import { useSpares } from "./dashboard.data";
import { panelsView, spareRows, type InflationRow, type SpareRowView } from "./dashboard.view";

interface DashboardPanelsProps {
  body: DashboardBody;
  depot?: string;
  depotFiltered: boolean;
}

const inflationColumns: Column<InflationRow>[] = [
  { key: "band", header: "Band", render: (b) => b.band },
  { key: "readings", header: "Readings", align: "right", mono: true, render: (b) => b.readings },
  { key: "tyres", header: "Tyres", align: "right", mono: true, render: (b) => b.tyres },
  { key: "share", header: "Share of classified", align: "right", render: (b) => b.share },
  { key: "cold", header: "Cold", align: "right", mono: true, render: (b) => b.cold },
  { key: "hot", header: "Hot", align: "right", mono: true, render: (b) => b.hot },
  { key: "unknown", header: "Unknown basis", align: "right", mono: true, render: (b) => b.unknown },
];

const spareColumns: Column<SpareRowView>[] = [
  { key: "code", header: "Tyre", mono: true, nowrap: true, render: (s) => s.code },
  {
    key: "unit",
    header: "Unit",
    nowrap: true,
    render: (s) => <Link to={`/fleet/units/${s.vehicleId}`}>{s.fleetNumber}</Link>,
  },
  { key: "position", header: "Position", mono: true, render: (s) => s.position },
  { key: "tread", header: "Tread", align: "right", mono: true, render: (s) => s.tread },
  { key: "source", header: "Source", basis: true, render: (s) => s.source },
  { key: "measured", header: "Last measured", render: (s) => s.measured },
  { key: "age", header: "Age (days)", align: "right", mono: true, render: (s) => s.age },
];

export function DashboardPanels({ body, depot, depotFiltered }: DashboardPanelsProps) {
  const formatDate = useTenantDate();
  const { inflation, tread, forecast, wear } = panelsView(body, depot, depotFiltered, formatDate);
  const spares = useSpares(depot);

  return (
    <>
      {/* FR-DSH-007: across the full width, since seven columns of per-band
          figures do not fit half a row. */}
      <Card title="Inflation compliance" description={inflation.judged} className="overview-wide">
        {inflation.unavailable !== undefined ? (
          <p className="clock-note">{inflation.unavailable}</p>
        ) : (
          <>
            {inflation.window !== undefined && <p className="clock-note">{inflation.window}</p>}
            <DataTable
              caption="Inflation compliance by band"
              columns={inflationColumns}
              rows={inflation.rows}
              rowKey={(b) => b.key}
              empty={<EmptyState title={absenceLabel("noReadingsInPeriod")} />}
            />
          </>
        )}
      </Card>

      {/* FR-DSH-008: the one chart, labelled from the bands' bounds (U40). */}
      <Card title="Tread depth" description={tread.judged}>
        <BandChart title="Tread depth across running positions" bands={tread.bands} />
      </Card>
      {/* FR-DSH-009 and 016, read with the chart, so they stack beside it. */}
      <div className="tile-stack">
        {/* The forecast list is a report (TYRE-6), so this tile has no
            link. */}
        <Metric
          label="Replacement window opens"
          value={forecast.value}
          detail={forecast.detail}
          data-requirement="FR-DSH-009"
        >
          <p className="tile-judged">{forecast.judged}</p>
        </Metric>
        <Metric
          label="Irregular wear"
          value={wear.value}
          detail={wear.detail}
          link={wear.link}
          data-requirement="FR-DSH-016"
        >
          <p className="tile-judged">{wear.judged}</p>
        </Metric>
      </div>

      {/* FR-DSH-019: the spares list, never on a tread-ranked panel, on its
          own clock (U9) and its own query (U51). */}
      <Card
        title="Spares"
        description={spares.data ? judgedAtLabel(spares.data.judgedAt) : undefined}
        className="overview-wide"
      >
        {spares.isError ? (
          <Banner tone="warning" title="The spares list did not load." />
        ) : (
          <DataTable
            caption="Spare tyres"
            columns={spareColumns}
            rows={spares.data ? spareRows(spares.data.spares, formatDate) : []}
            rowKey={(s) => s.key}
            loading={spares.isPending}
            empty={
              <EmptyState title={absenceLabel("noSpares")}>
                {absenceLabel("noSparesBody")}
              </EmptyState>
            }
          />
        )}
      </Card>
    </>
  );
}
