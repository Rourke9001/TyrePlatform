import { useState } from "react";

import type { Money } from "../api/money";
import { formatRand } from "../api/money";
import { BandChart } from "./BandChart";
import { Button } from "./Button";
import { DataTable, type Column } from "./DataTable";
import { Dialog } from "./Dialog";
import { EmptyState } from "./EmptyState";
import { FilterBar } from "./FilterBar";
import { FormField } from "./FormField";
import { PageHeader } from "./PageHeader";
import { Panel } from "./Panel";
import { ProvenanceSplit } from "./ProvenanceSplit";
import { Select } from "./Select";
import { SeverityBadge } from "./SeverityBadge";
import { StatTile } from "./StatTile";
import {
  INFLATION_BAND_KEYS,
  basisLabel,
  formatCount,
  formatMm,
  inflationBandLabel,
  judgedAtLabel,
} from "./vocabulary";

// Example values only. The money strings are typed as the brand so the
// gallery exercises formatRand the way a page would; nothing here is a
// fleet figure.
const rand = (s: string) => s as Money;

const bands = [
  { bandOrdinal: 1, lowerMm: 0, upperExclusiveMm: 5, tyreCount: 10, pctOfGroup: 37 },
  { bandOrdinal: 2, lowerMm: 5, upperExclusiveMm: 8, tyreCount: 4, pctOfGroup: 15 },
  { bandOrdinal: 3, lowerMm: 8, upperExclusiveMm: 11, tyreCount: 6, pctOfGroup: 22 },
  { bandOrdinal: 4, lowerMm: 11, upperExclusiveMm: 14, tyreCount: 5, pctOfGroup: 19 },
  { bandOrdinal: 5, lowerMm: 14, upperExclusiveMm: null, tyreCount: 2, pctOfGroup: 7 },
];

interface SampleRow {
  id: string;
  unit: string;
  position: string;
  tread: string;
  value: string;
  basis: string;
}

const rows: SampleRow[] = [
  {
    id: "1",
    unit: "HORSE",
    position: "POS3",
    tread: `${formatMm(2)} of ${formatMm(4)}`,
    value: formatRand(rand("16537.50")),
    basis: basisLabel("AUDIT"),
  },
  {
    id: "2",
    unit: "LINK12",
    position: "POS10",
    tread: `${formatMm(3.5)} of ${formatMm(4)}`,
    value: formatRand(rand("4212.75")),
    basis: basisLabel("ESTIMATED"),
  },
  {
    id: "3",
    unit: "TRAILER7",
    position: "POS22",
    tread: `${formatMm(11)} of ${formatMm(4)}`,
    value: formatRand(rand("20571.00")),
    basis: basisLabel("ACTUAL"),
  },
  {
    id: "4",
    unit: "LINK12",
    position: "POS2",
    tread: `${formatMm(6.5)} of ${formatMm(4)}`,
    value: formatRand(rand("980.10")),
    basis: basisLabel("AUDIT"),
  },
];

const columns: Column<SampleRow>[] = [
  { key: "unit", header: "Unit", cell: (r) => r.unit },
  { key: "position", header: "Position", cell: (r) => r.position },
  { key: "tread", header: "Tread against threshold", align: "right", cell: (r) => r.tread },
  { key: "value", header: "Casing value", align: "right", cell: (r) => r.value },
  { key: "basis", header: "Basis", basis: true, cell: (r) => r.basis },
];

// Dev only (routes.tsx gates it): the example page every component is
// reviewed on, and the page the PR's screenshots come from (TYRE-238 DoD).
export default function Gallery() {
  const [depot, setDepot] = useState("ALL");
  const [open, setOpen] = useState(false);
  return (
    <div className="gallery">
      <PageHeader
        title="Design system"
        eyebrow="Gallery"
        lede="Every component on the tokens, with example values."
        actions={<Button variant="secondary">Secondary</Button>}
      />

      <Panel id="g-buttons" title="Buttons">
        <div className="gallery-row">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="quiet">Quiet</Button>
          <Button variant="danger">Danger</Button>
          <Button compact>Compact</Button>
          <Button disabled>Disabled</Button>
        </div>
      </Panel>

      <Panel id="g-badges" title="Severity">
        <div className="gallery-row">
          <SeverityBadge severity="CRITICAL" />
          <SeverityBadge severity="WARNING" />
          <SeverityBadge severity="INFO" />
        </div>
      </Panel>

      <Panel
        id="g-tiles"
        title="Stat tiles"
        judged={judgedAtLabel("SUBMITTED_AT")}
        actions={
          <Button variant="quiet" compact>
            See all
          </Button>
        }
      >
        <div className="gallery-tiles">
          <StatTile
            label="Open exceptions"
            value={formatCount(19)}
            qualifier="11 critical"
            judged={judgedAtLabel("SUBMITTED_AT")}
            to="/exceptions"
            tone="critical"
          />
          <StatTile
            label="Below the removal threshold"
            value={formatCount(9)}
            qualifier="1 spare, disclosed separately"
            judged={judgedAtLabel("TODAY")}
            tone="warning"
          />
          <StatTile
            label="Overdue tasks"
            value={formatCount(0)}
            judged={judgedAtLabel("TENANT_TODAY")}
          />
        </div>
      </Panel>

      <Panel id="g-provenance" title="Provenance split">
        <ProvenanceSplit
          caption="Casing value provenance"
          segments={[
            { key: "actual", label: "Actual", count: 3 },
            { key: "audit", label: "Audit", count: 20 },
            { key: "estimated", label: "Estimated", count: 2 },
            { key: "unvalued", label: "Unvalued", count: 2 },
          ]}
        />
      </Panel>

      <Panel id="g-inflation" title="Inflation bands">
        <ul className="gallery-list">
          {INFLATION_BAND_KEYS.map((key) => (
            <li key={key}>{inflationBandLabel(key)}</li>
          ))}
        </ul>
      </Panel>

      <Panel id="g-chart" title="Band chart">
        <BandChart title="Tread depth across running positions" bands={bands} />
      </Panel>

      <Panel id="g-table" title="Data table">
        <DataTable
          caption="Example tyres"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={<EmptyState title="No rows" />}
        />
        <div className="gallery-row">
          <EmptyState title="No spares" action={<Button variant="quiet">Units</Button>}>
            No spare position carries a tyre.
          </EmptyState>
        </div>
      </Panel>

      {/* The skeleton's block rule lives in dashboard.css, which only the
          shell loads, so this sample is where a missing one shows. */}
      <Panel id="g-table-loading" title="Data table, loading">
        <DataTable
          caption="Example tyres, loading"
          columns={columns}
          rows={[]}
          rowKey={(r) => r.id}
          loading
          empty={<EmptyState title="No rows" />}
        />
      </Panel>

      <Panel id="g-forms" title="Filter bar, fields, select and dialog">
        <FilterBar onRefresh={() => undefined}>
          <FormField id="g-depot" label="Depot">
            <Select
              id="g-depot"
              value={depot}
              onValueChange={setDepot}
              options={[
                { value: "ALL", label: "All depots" },
                { value: "jhb", label: "Johannesburg" },
                { value: "dbn", label: "Durban" },
              ]}
            />
          </FormField>
          <FormField id="g-from" label="From" hint="YYYY-MM-DD">
            <input id="g-from" type="date" />
          </FormField>
          <FormField id="g-to" label="To" error="Needs a from date as well">
            <input id="g-to" type="date" />
          </FormField>
        </FilterBar>
        <div className="gallery-row">
          <Button onClick={() => setOpen(true)}>Open a dialog</Button>
        </div>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="Example dialog"
          description="Escape closes it; focus returns to the button."
        >
          <p>Dialog body.</p>
        </Dialog>
      </Panel>
    </div>
  );
}
