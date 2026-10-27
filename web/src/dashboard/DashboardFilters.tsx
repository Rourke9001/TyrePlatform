import { useEffect, useEffectEvent, useState } from "react";

import type { DashboardParams } from "../api/dashboard";
import { useActor } from "../auth/actorContext";
import { absenceLabel } from "../domain/vocabulary";
import { Field } from "../ui/Field";
import { Select } from "../ui/legacy/Select";
import { TextInput } from "../ui/TextInput";
import { useDepots } from "./dashboard.data";
import { PERIOD_SETTLE_MS, settlePeriod } from "./dashboardParams";
import { FilterBar } from "./FilterBar";

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
  const depots = useDepots();
  // FR-DSH-011: the fields hold what is being typed and the URL holds the
  // period, so a link or Back that moves the URL resets the fields to it.
  const [draft, setDraft] = useState({ from: params.from ?? "", to: params.to ?? "" });
  const [urlPeriod, setUrlPeriod] = useState({ from: params.from, to: params.to });
  if (urlPeriod.from !== params.from || urlPeriod.to !== params.to) {
    setUrlPeriod({ from: params.from, to: params.to });
    setDraft({ from: params.from ?? "", to: params.to ?? "" });
  }

  // U42, U87: a depot-scoped actor is offered only the depots GET /api/me
  // names as theirs. Presentation only (NFR-SEC-006). Any breadth but
  // TENANT counts as depot-scoped, failing closed as the server does.
  const depotScoped = actor?.scope !== "TENANT";
  const mine = new Set(actor?.depots ?? []);
  const options = [
    { value: "", label: depotScoped ? "All my depots" : "All depots" },
    ...(depots.data ?? [])
      .filter((d) => FILTER_DEPOT_TYPES.has(d.type))
      .filter((d) => !depotScoped || mine.has(d.id))
      .map((d) => ({ value: d.id, label: d.name })),
  ];
  // Radix shows a blank trigger for a value no option carries, so a URL
  // depot the list does not offer is named as unlisted and can be cleared.
  // Never by its name: that may be a depot the actor's scope excludes (U42).
  if (params.depot !== undefined && !options.some((o) => o.value === params.depot)) {
    options.push({ value: params.depot, label: absenceLabel("unlistedDepot") });
  }
  // Radix shows its placeholder only for an empty value, so a depot named in
  // the URL is held back while its name is unknown rather than shown blank.
  const naming = params.depot !== undefined && depots.isPending;

  // U52: both dates or neither, and the field's hint says why. "" for
  // neither; a period still being typed or out of order is not sent.
  const settled = settlePeriod(draft.from, draft.to);
  const nextFrom = settled.kind === "set" ? settled.from : "";
  const nextTo = settled.kind === "set" ? settled.to : "";
  const due =
    settled.kind !== "wait" && (nextFrom !== (params.from ?? "") || nextTo !== (params.to ?? ""));

  const sendPeriod = useEffectEvent((from: string, to: string) => {
    const rest = { ...params };
    delete rest.from;
    delete rest.to;
    onChange(from && to ? { ...rest, from, to } : rest);
  });

  // U41: a period is sent once the fields hold still, so a year typed digit
  // by digit is one request; a URL change that overtakes it cancels it.
  useEffect(() => {
    if (!due) return;
    const timer = window.setTimeout(() => sendPeriod(nextFrom, nextTo), PERIOD_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [due, nextFrom, nextTo]);

  return (
    <FilterBar onRefresh={onRefresh} refreshing={refreshing}>
      <Field label="Depot" hint={depots.isError ? "Depots did not load" : undefined}>
        <Select
          id="depot"
          value={naming ? "" : (params.depot ?? "")}
          placeholder="Loading depots"
          onValueChange={(value) => {
            const rest = { ...params };
            delete rest.depot;
            onChange(value === "" ? rest : { ...rest, depot: value });
          }}
          options={naming ? [] : options}
        />
      </Field>
      <Field label="Inflation period from" hint="Both dates, or neither for the configured window">
        <TextInput
          id="from"
          type="date"
          value={draft.from}
          onChange={(e) => setDraft({ ...draft, from: e.target.value })}
        />
      </Field>
      <Field
        label="to"
        hint="Exclusive"
        error={
          settled.kind === "wait" && settled.misordered ? (
            // Spoken when it appears: the period is refused without moving
            // focus off the field being typed in.
            <span role="alert">Must be after the from date</span>
          ) : undefined
        }
      >
        {/* WCAG 2.5.3: the visible label is "to"; the accessible name says
            which field, and still contains the visible word. */}
        <TextInput
          id="to"
          type="date"
          aria-label="Inflation period to"
          value={draft.to}
          onChange={(e) => setDraft({ ...draft, to: e.target.value })}
        />
      </Field>
    </FilterBar>
  );
}
