// Gallery.tsx reads `section` through its glob, so a sample that needs a
// hook is declared beside it; this dev-only page reloads on an edit rather
// than hot-swapping (TYRE-447).
/* eslint-disable react-refresh/only-export-components */
import { useState, type CSSProperties, type ReactNode } from "react";
import { MemoryRouter, useInRouterContext } from "react-router";

import { formatMoney, type Money } from "../../api/money";
import { basisLabel } from "../../domain/vocabulary";
import { formatCount, formatMm } from "../../format/numbers";
import { formatTenantDate } from "../../time/tenantTime";
import { Card } from "../Card";
import { DataTable, type Column } from "../DataTable";
import { KeyValue } from "../KeyValue";
import { ListRow } from "../ListRow";
import { Metric } from "../Metric";
import { Progress } from "../Progress";
import { Timeline } from "../Timeline";
import type { GallerySection } from "./types";

// Example values only, in the Sandbox tenant's voice; none is a fleet
// figure. The money strings are round amounts typed as the brand, so the
// gallery formats them the way a page would. The gallery's own test
// renders it without a router and the dev route inside one, so a sample
// with links brings a router only when it has none.
function Routed({ children }: { children: ReactNode }) {
  return useInRouterContext() ? children : <MemoryRouter>{children}</MemoryRouter>;
}

const rand = (s: string) => s as Money;
const ZONE = "Africa/Johannesburg";

const grid: CSSProperties = {
  display: "grid",
  gap: "var(--space-4)",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))",
};

interface SampleRow {
  id: string;
  unit: string;
  position: string;
  tread: string;
  value: string;
  basis: string;
}

// The sample threshold is a labelled prop on a page, never a constant
// here (rule 5); this row only shows how a below-threshold row reads.
const rows: SampleRow[] = [
  {
    id: "1",
    unit: "TRK-01",
    position: "3",
    tread: formatMm(2),
    value: formatMoney(rand("15000.00"), "ZAR"),
    basis: basisLabel("AUDIT"),
  },
  {
    id: "2",
    unit: "TRL-02",
    position: "10",
    tread: formatMm(3.5),
    value: formatMoney(rand("4000.00"), "ZAR"),
    basis: basisLabel("ESTIMATED"),
  },
  {
    id: "3",
    unit: "TRL-03",
    position: "22",
    tread: formatMm(11),
    value: formatMoney(rand("1250.50"), "ZAR"),
    basis: basisLabel("ESTIMATED"),
  },
];

const columns: Column<SampleRow>[] = [
  { key: "unit", header: "Unit", nowrap: true, mono: true, render: (r) => r.unit },
  { key: "position", header: "Position", align: "right", render: (r) => r.position },
  { key: "tread", header: "Tread", align: "right", mono: true, render: (r) => r.tread },
  { key: "value", header: "Casing value", align: "right", mono: true, render: (r) => r.value },
  { key: "basis", header: "Basis", basis: true, render: (r) => r.basis },
];

function TableSample() {
  const [selected, setSelected] = useState<string | undefined>(undefined);
  return (
    <div className="tr-stack">
      <DataTable
        caption="Sample tyres"
        captionVisible
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => setSelected(r.id)}
        selectedKey={selected}
        rowTone={(r) => (r.id === "1" ? "critical" : undefined)}
      />
      <DataTable
        caption="Sample tyres, loading"
        captionVisible
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        loading
      />
      <DataTable
        caption="Sample tyres, none"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<p>No tyres at or below the sample threshold.</p>}
      />
    </div>
  );
}

function DataSamples() {
  return (
    <Routed>
      <div className="tr-stack">
        <div style={grid}>
          <Metric
            label="Open exceptions"
            value={formatCount(19)}
            tone="critical"
            detail="11 urgent; 9 rules configured"
            link={{ to: "/exceptions", label: "See the list" }}
          >
            as inspected
          </Metric>
          <Metric
            label="Inspection coverage"
            value={`${formatCount(42)} of ${formatCount(48)}`}
            detail="6 overdue"
            tone="warning"
          />
          <Metric label="Spares fitted" value={formatCount(12)} unit="tyres" tone="ok" />
        </div>
        <Metric
          size="hero"
          label="Value at risk"
          value={formatMoney(rand("16537.50"), "ZAR")}
          detail="from 9 running tyres at or below the sample threshold today"
          headingLevel={2}
        />
        <Card
          title="Sample trip"
          eyebrow="Today"
          description="A card titles a region; a list runs edge to edge inside it."
          padding="none"
          actions={<button type="button">Refresh</button>}
        >
          <ul className="tr-list">
            <li>
              <ListRow to="/dev/design" title="TRK-01" meta="Truck, 6 tyres" trailing="Check" />
            </li>
            <li>
              <ListRow to="/dev/design">TRL-02, due 27 Oct (overdue)</ListRow>
            </li>
            <li>
              <ListRow onClick={() => undefined} title="Receive tyres" meta="A button row" />
            </li>
            <li>
              <ListRow>TRL-03</ListRow>
            </li>
          </ul>
        </Card>
        <Card title="Sample tyre" level={3}>
          <KeyValue
            columns={3}
            items={[
              { label: "Code", value: "T-104", mono: true },
              { label: "Size", value: "315/80R22.5", mono: true },
              { label: "Depot", value: "Sandbox depot" },
              { label: "Fitted", value: formatTenantDate("2026-10-12T05:42:00Z", ZONE) },
            ]}
          />
        </Card>
        <TableSample />
        <Timeline
          aria-label="Sample tyre history"
          items={[
            {
              id: "1",
              when: formatTenantDate("2026-10-12T05:42:00Z", ZONE),
              title: "Fitted to TRK-01, position 3",
              tone: "ok",
            },
            {
              id: "2",
              when: formatTenantDate("2026-10-20T06:10:00Z", ZONE),
              title: `Read ${formatMm(3)}`,
              detail: "Below the sample threshold",
              tone: "critical",
            },
            {
              id: "3",
              when: formatTenantDate("2026-10-24T07:00:00Z", ZONE),
              title: "Pressure low on one reading",
              tone: "warn",
            },
            { id: "4", when: formatTenantDate("2026-10-26T08:00:00Z", ZONE), title: "Note added" },
          ]}
        />
        <Progress
          label="Sample walk-around"
          segments={[
            { label: "TRK-01", done: 6, total: 6 },
            { label: "TRL-02", done: 4, total: 12 },
          ]}
        />
      </div>
    </Routed>
  );
}

export const section: GallerySection = {
  id: "data",
  title: "Data: figures, cards, rows, tables, history, progress",
  render: () => <DataSamples />,
};
