// The Radix pickers' look; the rest of the page is Tread's.
import "../ui/legacy/ui.css";
import { Link, useSearchParams } from "react-router";

import type { ExceptionsParams } from "../api/dashboard";
import { useActor } from "../auth/actorContext";
import { absenceLabel } from "../domain/vocabulary";
import { useTenantInstant } from "../time/tenantTime";
import { Banner } from "../ui/Banner";
import { Card } from "../ui/Card";
import { Checkbox } from "../ui/Checkbox";
import { DataTable, type Column } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { Field } from "../ui/Field";
import { Select } from "../ui/legacy/Select";
import { PageHeader } from "../ui/PageHeader";
import { useDepotName, useExceptions } from "./dashboard.data";
import { ExceptionSeverity } from "./ExceptionSeverity";
import {
  exceptionRows,
  exceptionsLede,
  readExceptionsParams,
  ruleOptions,
  severityOptions,
  writeExceptionsParams,
  type ExceptionRowView,
} from "./exceptions.view";
import { FilterBar } from "./FilterBar";
import "./analytics.css";

const columns: Column<ExceptionRowView>[] = [
  {
    key: "rule",
    header: "Rule",
    // The code sits on its own line: it is what ties a row back to the
    // specification.
    render: (r) => (
      <span className="cell-rule">
        {r.ruleName} <span className="rule-code">{r.ruleCode}</span>
      </span>
    ),
  },
  { key: "severity", header: "Severity", render: (r) => <ExceptionSeverity code={r.severity} /> },
  {
    key: "unit",
    header: "Unit",
    nowrap: true,
    render: (r) => <Link to={`/fleet/units/${r.vehicleId}`}>{r.fleetNumber}</Link>,
  },
  { key: "position", header: "Position", render: (r) => r.position },
  {
    key: "measure",
    header: "Measure against threshold",
    align: "right",
    mono: true,
    render: (r) => r.measure,
  },
  { key: "seen", header: "Last seen", render: (r) => r.seen },
  { key: "resolved", header: "Replaced since", render: (r) => r.replaced },
];

// U18: the filtered table the dashboard's tiles link to. Its filters stay
// the Severity and Rule pickers and "Include replaced": no tabs, search or
// side sheet (TYRE-443 spec, what does not port).
export default function Exceptions() {
  const [search, setSearch] = useSearchParams();
  const params = readExceptionsParams(search);
  const actor = useActor();
  const formatInstant = useTenantInstant();
  const list = useExceptions(params);
  const depotName = useDepotName(params.depot);
  const rows = list.data?.exceptions ?? [];

  function update(next: Partial<ExceptionsParams>) {
    setSearch(writeExceptionsParams({ ...params, ...next }));
  }

  return (
    <div className="analytics-page">
      <PageHeader
        title="Exceptions"
        description={
          list.data
            ? exceptionsLede(rows.length, list.data.judgedAt, params.depot, depotName)
            : undefined
        }
      />
      <FilterBar onRefresh={() => void list.refetch()} refreshing={list.isFetching}>
        <Field label="Severity">
          <Select
            id="severity"
            value={params.severity ?? ""}
            onValueChange={(v) => update({ severity: v === "" ? undefined : v })}
            options={severityOptions()}
          />
        </Field>
        <Field label="Rule">
          <Select
            id="rule"
            value={params.rule ?? ""}
            onValueChange={(v) => update({ rule: v === "" ? undefined : v })}
            options={ruleOptions(rows, params.rule)}
          />
        </Field>
        <Checkbox
          id="resolved"
          label="Include replaced"
          checked={Boolean(params.includeResolved)}
          onChange={(e) => update({ includeResolved: e.target.checked || undefined })}
        />
      </FilterBar>
      {list.isError ? (
        <Banner tone="warning" title="The exceptions list did not load." />
      ) : (
        <Card padding="none">
          <DataTable
            caption="Exceptions"
            columns={columns}
            rows={exceptionRows(rows, formatInstant)}
            rowKey={(r) => r.key}
            rowTone={(r) => r.tone}
            loading={list.isPending}
            cardHeadingLevel={2}
            empty={
              <EmptyState title={absenceLabel("noOpenExceptions")} headingLevel={2}>
                {absenceLabel("noOpenExceptionsBody")}
              </EmptyState>
            }
          />
        </Card>
      )}
      {/* Rule 6: every time above is the tenant's, and the zone is named
          once, here, rather than on each row. */}
      <p className="clock-note">
        Times are {actor?.timezone ?? "UTC"}. Each row is judged at the inspection it was raised
        from, so a row can be older than today's value at risk.
      </p>
    </div>
  );
}
