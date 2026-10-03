import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";

import { fetchExceptions, type ExceptionRow, type ExceptionsParams } from "../api/dashboard";
import { getDevTenantId } from "../api/devTenant";
import { fetchDepots } from "../api/units";
import { useActor } from "../auth/actorContext";
import { depotsKey, exceptionsKey } from "../fleet/unit/queryKeys";
import { useTenantInstant } from "../time/tenantTime";
import { DataTable, type Column } from "../ui/DataTable";
import { EmptyState } from "../ui/EmptyState";
import { FilterBar } from "../ui/FilterBar";
import { FormField } from "../ui/FormField";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { SeverityBadge } from "../ui/SeverityBadge";
import {
  absenceLabel,
  formatMm,
  formatPct,
  judgedAtLabel,
  plural,
  SEVERITY_CODES,
  severityLabel,
  subjectPositionLabel,
} from "../ui/vocabulary";
import "./analytics.css";

// The URL spells includeResolved as resolved; this and update() below are
// the only two places that know both spellings.
function readParams(search: URLSearchParams): ExceptionsParams {
  const params: ExceptionsParams = {};
  const severity = search.get("severity");
  const rule = search.get("rule");
  const depot = search.get("depot");
  if (severity) params.severity = severity;
  if (rule) params.rule = rule;
  if (depot) params.depot = depot;
  if (search.get("resolved") === "true") params.includeResolved = true;
  return params;
}

// U18: every v_exception row carries the threshold it was judged against,
// so the measure and its threshold share a unit and the row explains itself.
function measure(row: ExceptionRow): string {
  if (row.measureMm !== null && row.thresholdMm !== null)
    return `${formatMm(row.measureMm)} of ${formatMm(row.thresholdMm)}`;
  if (row.measurePct !== null && row.thresholdPct !== null)
    return `${formatPct(row.measurePct)} of ${formatPct(row.thresholdPct)}`;
  return absenceLabel("unmeasured");
}

// U18: the filtered table the dashboard's tiles link to, judged as
// inspected; the count line says so, since the at-risk list two clicks away
// is judged today and the two can disagree.
export default function Exceptions() {
  const [search, setSearch] = useSearchParams();
  const params = readParams(search);
  const tenantKey = getDevTenantId() ?? "default";
  const actor = useActor();
  const formatInstant = useTenantInstant();
  const list = useQuery({
    queryKey: exceptionsKey(tenantKey, params),
    queryFn: () => fetchExceptions(params),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  // A depot view names its depot; the depots query shares the dashboard's
  // cache entry.
  const depots = useQuery({
    queryKey: depotsKey(tenantKey),
    queryFn: () => fetchDepots(),
    enabled: params.depot !== undefined,
  });
  const depotName = depots.data?.find((d) => d.id === params.depot)?.name;

  const rows = list.data?.exceptions ?? [];
  // The rule filter's options are the codes present plus the one chosen,
  // so a link from a tile always finds its rule in the list.
  const ruleCodes = Array.from(
    new Set(rows.map((r) => r.ruleCode).concat(params.rule ? [params.rule] : [])),
  ).sort();

  function update(next: Partial<ExceptionsParams>) {
    const merged = { ...params, ...next };
    const out = new URLSearchParams();
    if (merged.severity) out.set("severity", merged.severity);
    if (merged.rule) out.set("rule", merged.rule);
    if (merged.depot) out.set("depot", merged.depot);
    if (merged.includeResolved) out.set("resolved", "true");
    setSearch(out);
  }

  function lede(judgedAt: string): string {
    const parts = [plural(rows.length, "exception", "exceptions"), judgedAtLabel(judgedAt)];
    if (params.depot !== undefined) {
      parts.push(`at ${depotName ?? absenceLabel("unnamedDepot")}`);
    }
    return parts.join(", ");
  }

  const columns: Column<ExceptionRow>[] = [
    {
      key: "rule",
      header: "Rule",
      // The accepted mockup sets the code on its own line: it is what ties
      // a row back to the specification.
      cell: (r) => (
        <span className="cell-rule">
          {r.ruleName} <span className="rule-code">{r.ruleCode}</span>
        </span>
      ),
    },
    { key: "severity", header: "Severity", cell: (r) => <SeverityBadge severity={r.severity} /> },
    {
      key: "unit",
      header: "Unit",
      cell: (r) => <Link to={`/fleet/units/${r.vehicleId}`}>{r.fleetNumber}</Link>,
    },
    {
      key: "position",
      header: "Position",
      cell: (r) => subjectPositionLabel(r.subjectType, r.positionCode, r.positionCode2, r.isSpare),
    },
    { key: "measure", header: "Measure against threshold", align: "right", cell: measure },
    { key: "seen", header: "Last seen", cell: (r) => formatInstant(r.observedAt) },
    {
      key: "resolved",
      header: "Replaced since",
      cell: (r) => (r.resolvedByFitment ? "Yes" : "No"),
    },
  ];

  return (
    <div className="analytics-page">
      <PageHeader title="Exceptions" lede={list.data ? lede(list.data.judgedAt) : undefined} />
      <FilterBar onRefresh={() => void list.refetch()} refreshing={list.isFetching}>
        <FormField id="severity" label="Severity">
          <Select
            id="severity"
            value={params.severity ?? ""}
            onValueChange={(v) => update({ severity: v === "" ? undefined : v })}
            options={[
              { value: "", label: "All severities" },
              ...SEVERITY_CODES.map((s) => ({ value: s, label: severityLabel(s) })),
            ]}
          />
        </FormField>
        <FormField id="rule" label="Rule">
          <Select
            id="rule"
            value={params.rule ?? ""}
            onValueChange={(v) => update({ rule: v === "" ? undefined : v })}
            options={[
              { value: "", label: "All rules" },
              ...ruleCodes.map((c) => ({ value: c, label: c })),
            ]}
          />
        </FormField>
        <FormField id="resolved" label="Include replaced">
          <input
            id="resolved"
            type="checkbox"
            checked={Boolean(params.includeResolved)}
            onChange={(e) => update({ includeResolved: e.target.checked || undefined })}
          />
        </FormField>
      </FilterBar>
      {list.isError ? (
        <p role="alert">The exceptions list did not load.</p>
      ) : (
        <DataTable
          caption="Exceptions"
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.ruleCode}:${r.subjectId}:${r.inspectionId}`}
          loading={list.isPending}
          cardHeadingLevel={2}
          empty={
            <EmptyState title={absenceLabel("noOpenExceptions")} headingLevel={2}>
              {absenceLabel("noOpenExceptionsBody")}
            </EmptyState>
          }
        />
      )}
      {/* Rule 6: every time above is the tenant's, and the accepted mockup
          names the zone once, here, rather than on each row. */}
      <p className="clock-note">
        Times are {actor?.timezone ?? "UTC"}. Each row is judged at the inspection it was raised
        from, so a row can be older than today's value at risk.
      </p>
    </div>
  );
}
