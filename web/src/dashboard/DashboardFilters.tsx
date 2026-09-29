import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { DashboardParams } from "../api/dashboard";
import { getDevTenantId } from "../api/devTenant";
import { fetchDepots } from "../api/units";
import { useActor } from "../auth/actorContext";
import { depotsKey } from "../fleet/unit/queryKeys";
import { FilterBar } from "../ui/FilterBar";
import { FormField } from "../ui/FormField";
import { Select } from "../ui/Select";

// U85: the dashboard's depot filter offers these two types only. GET
// /api/depots takes one ?type= per call, so the one untyped list is
// narrowed here; which types to offer is display, not a tyre rule.
const FILTER_DEPOT_TYPES = new Set(["DEPOT", "STORE"]);

interface DashboardFiltersProps {
  params: DashboardParams;
  onChange: (params: DashboardParams) => void;
  onRefresh: () => void;
  refreshing: boolean;
}

export function DashboardFilters({
  params,
  onChange,
  onRefresh,
  refreshing,
}: DashboardFiltersProps) {
  const actor = useActor();
  const tenantKey = getDevTenantId() ?? "default";
  const depots = useQuery({ queryKey: depotsKey(tenantKey), queryFn: () => fetchDepots() });
  const [from, setFrom] = useState(params.from ?? "");
  const [to, setTo] = useState(params.to ?? "");

  // U42, U87: a depot-scoped actor is offered only the depots GET /api/me
  // names as theirs. Presentation only (NFR-SEC-006).
  const depotScoped = actor?.scope === "DEPOT";
  const mine = new Set(actor?.depots ?? []);
  const options = [
    { value: "", label: depotScoped ? "All my depots" : "All depots" },
    ...(depots.data ?? [])
      .filter((d) => FILTER_DEPOT_TYPES.has(d.type))
      .filter((d) => !depotScoped || mine.has(d.id))
      .map((d) => ({ value: d.id, label: d.name })),
  ];
  // Radix shows its placeholder only for an empty value, so a depot named in
  // the URL is held back while its name is unknown rather than shown blank.
  const naming = params.depot !== undefined && (depots.isPending || depots.isError);

  // U52: both dates or neither; a half-set period leaves the request as it
  // was, and the field's hint says why.
  function applyPeriod(nextFrom: string, nextTo: string) {
    setFrom(nextFrom);
    setTo(nextTo);
    const rest = { ...params };
    delete rest.from;
    delete rest.to;
    onChange(nextFrom && nextTo ? { ...rest, from: nextFrom, to: nextTo } : rest);
  }

  return (
    <FilterBar onRefresh={onRefresh} refreshing={refreshing}>
      <FormField id="depot" label="Depot">
        <Select
          id="depot"
          value={naming ? "" : (params.depot ?? "")}
          placeholder={depots.isError ? "Depots did not load" : "Loading depots"}
          onValueChange={(value) => {
            const rest = { ...params };
            delete rest.depot;
            onChange(value === "" ? rest : { ...rest, depot: value });
          }}
          options={naming ? [] : options}
        />
      </FormField>
      <FormField
        id="from"
        label="Inflation period from"
        hint="Both dates, or neither for the configured window"
      >
        <input
          id="from"
          type="date"
          value={from}
          onChange={(e) => applyPeriod(e.target.value, to)}
        />
      </FormField>
      <FormField id="to" label="to" hint="Exclusive">
        {/* WCAG 2.5.3: the mockup's visible label is "to"; the accessible
            name says which field, and still contains the visible word. */}
        <input
          id="to"
          type="date"
          aria-label="Inflation period to"
          value={to}
          onChange={(e) => applyPeriod(from, e.target.value)}
        />
      </FormField>
    </FilterBar>
  );
}
