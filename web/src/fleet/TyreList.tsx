import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { ApiError } from "../api/client";
import { getDevTenantId } from "../api/devTenant";
import { disposeTyre, fetchTyres, type Disposal, type Tyre } from "../api/tyres";
import { useCan } from "../auth/actorContext";
import { useTenantDate } from "../time/tenantTime";
import "./fleet.css";

// fetchTyres's own optional-filter shape, not redeclared: the two are one
// contract, and the query key below carries this object verbatim so a query
// key idiom used elsewhere (AddUnit.tsx) applies unchanged here.
type TyreFilters = NonNullable<Parameters<typeof fetchTyres>[0]>;

const DISPOSALS: { value: Disposal; label: string }[] = [
  { value: "SCRAPPED", label: "Scrapped" },
  { value: "SOLD", label: "Sold" },
  { value: "LOST", label: "Lost" },
];

// A refused disposal says what happened in the words of whoever knows: the
// tyre lifecycle's own refusals (TY011..TY013, ADR-0012's TY class) and the
// register's own conflict codes are safe to render verbatim (ADR-0013);
// anything else gets the general sentence rather than a wrong specific one.
// Shape mirrors AddUnit.tsx:22-33.
function refusalMessage(error: unknown): string {
  if (error instanceof ApiError && error.code !== null) {
    const speakable = [
      "display_code_taken",
      "TY011",
      "TY012",
      "TY013",
      "invalid_submission",
      "conflict",
    ];
    if (speakable.includes(error.code) && error.message !== "") {
      return error.message;
    }
    if (error.code === "forbidden") {
      return "You do not have permission to dispose of a tyre.";
    }
  }
  return "The tyre could not be disposed of. Try again, or call support if it keeps happening.";
}

// NFR-USE-012: natural order, not lexicographic (POS2 before POS10).
// vehicleSearch.ts holds the sibling comparator, but as a module-private
// const typed around Vehicle, so it is not reachable from here.
function byDisplayCode(a: Tyre, b: Tyre): number {
  return a.displayCode.localeCompare(b.displayCode, undefined, { numeric: true });
}

// FR-TYR-043: two active tyres carrying one code is a state the register
// must surface, never resolve on the user's behalf (ADR-0008 rule 3).
function multiMatchNote(count: number, code: string): string {
  const subject = count === 2 ? "Two tyres" : `${count} tyres`;
  return `${subject} carried code ${code} on that date — resolve by eye, the system never guesses.`;
}

export function TyreList() {
  const tenantKey = getDevTenantId() ?? "default";
  const canSeeMoney = useCan("ViewValuation");
  const asOf = useTenantDate();

  const [awaitingCost, setAwaitingCost] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [dateInput, setDateInput] = useState("");
  const [lookup, setLookup] = useState<{ code: string; on: string } | null>(null);

  // code+on take over from the awaiting-cost toggle when a lookup is active
  // (FR-TYR-042 resolves by date, not by the backlog filter) — the same
  // precedence listTyres itself applies server-side.
  const filters: TyreFilters = lookup ? { code: lookup.code, on: lookup.on } : { awaitingCost };

  const tyres = useQuery({
    queryKey: ["tyres", tenantKey, filters],
    queryFn: () => fetchTyres(filters),
  });

  function submitLookup(e: FormEvent) {
    e.preventDefault();
    if (codeInput.trim() === "" || dateInput === "") return;
    setLookup({ code: codeInput.trim(), on: dateInput });
  }

  function clearLookup() {
    setLookup(null);
    setCodeInput("");
    setDateInput("");
  }

  const rows = tyres.isSuccess ? [...tyres.data].sort(byDisplayCode) : [];

  return (
    <section aria-labelledby="tyres-heading" className="tyres">
      <h1 id="tyres-heading">Tyres</h1>

      <form className="tyres-lookup" onSubmit={submitLookup}>
        <label htmlFor="lookup-code">Display code</label>
        <input
          id="lookup-code"
          value={codeInput}
          onChange={(e) => setCodeInput(e.target.value)}
          required
        />
        <label htmlFor="lookup-date">As of date</label>
        <input
          id="lookup-date"
          type="date"
          value={dateInput}
          onChange={(e) => setDateInput(e.target.value)}
          required
        />
        <button type="submit">Find tyre</button>
        {lookup && (
          <button type="button" onClick={clearLookup}>
            Show full register
          </button>
        )}
      </form>

      {!lookup && (
        <label className="tyres-filter">
          <input
            type="checkbox"
            checked={awaitingCost}
            onChange={(e) => setAwaitingCost(e.target.checked)}
          />
          Awaiting cost only
        </label>
      )}

      {lookup && tyres.isSuccess && rows.length > 1 && (
        <p className="tyres-lookup-note">{multiMatchNote(rows.length, lookup.code)}</p>
      )}

      {tyres.isPending && <p>Loading…</p>}

      {tyres.isError && (
        <div className="tyres-note" role="alert">
          <h2>Tyres didn&apos;t load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <button type="button" onClick={() => void tyres.refetch()}>
            Retry
          </button>
        </div>
      )}

      {tyres.isSuccess && rows.length === 0 && <p className="tyres-note">No tyres match.</p>}

      {tyres.isSuccess && rows.length > 0 && (
        <table className="tyres-table">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Size</th>
              <th scope="col">Brand</th>
              <th scope="col">Pattern</th>
              <th scope="col">State</th>
              <th scope="col">Received</th>
              <th scope="col">Awaiting cost</th>
              {canSeeMoney && <th scope="col">Purchase price</th>}
              {canSeeMoney && <th scope="col">Rand/mm</th>}
              {canSeeMoney && <th scope="col">Casing value</th>}
              <th scope="col">Dispose</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <th scope="row">{t.displayCode}</th>
                <td>{t.sizeName ?? "—"}</td>
                <td>{t.brandName ?? "—"}</td>
                <td>{t.patternName ?? "—"}</td>
                <td>{t.state}</td>
                <td>{t.receivedDate ? asOf(t.receivedDate) : "Not received"}</td>
                <td>{t.awaitingCost ? "Yes" : "No"}</td>
                {canSeeMoney && <td>{t.purchasePrice ? `R ${t.purchasePrice}` : "—"}</td>}
                {canSeeMoney && <td>{t.randPerMm ? `R ${t.randPerMm}` : "—"}</td>}
                {canSeeMoney && <td>{t.casingValue ? `R ${t.casingValue}` : "—"}</td>}
                <td>
                  <DisposeForm tyre={t} tenantKey={tenantKey} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// Every rule about which transitions are legal, and about reason/proceeds,
// is app.dispose_tyre's alone (ADR-0013 decision 5) — this only shapes the
// request and shows the field the chosen disposal actually needs.
function DisposeForm({ tyre, tenantKey }: { tyre: Tyre; tenantKey: string }) {
  const queryClient = useQueryClient();
  const [disposal, setDisposal] = useState<Disposal | "">("");
  const [reason, setReason] = useState("");
  const [proceeds, setProceeds] = useState("");

  const dispose = useMutation({
    mutationFn: (vars: { disposal: Disposal; reason?: string; proceeds?: string }) =>
      disposeTyre(tyre.id, vars),
    onSuccess: () => {
      setDisposal("");
      setReason("");
      setProceeds("");
      void queryClient.invalidateQueries({ queryKey: ["tyres", tenantKey] });
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (disposal === "") return;
    dispose.mutate({
      disposal,
      reason: disposal === "SCRAPPED" ? reason : undefined,
      proceeds: disposal === "SOLD" ? proceeds : undefined,
    });
  }

  return (
    <form onSubmit={submit} className="tyre-dispose">
      <select
        aria-label={`Disposal for ${tyre.displayCode}`}
        value={disposal}
        onChange={(e) => setDisposal(e.target.value as Disposal | "")}
      >
        <option value="">Choose…</option>
        {DISPOSALS.map((d) => (
          <option key={d.value} value={d.value}>
            {d.label}
          </option>
        ))}
      </select>

      {disposal === "SCRAPPED" && (
        <input
          aria-label={`Reason for ${tyre.displayCode}`}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      )}

      {disposal === "SOLD" && (
        <input
          aria-label={`Proceeds for ${tyre.displayCode}`}
          value={proceeds}
          onChange={(e) => setProceeds(e.target.value)}
          inputMode="decimal"
          required
        />
      )}

      <button type="submit" disabled={disposal === "" || dispose.isPending}>
        {dispose.isPending ? "Disposing…" : "Dispose"}
      </button>

      {dispose.isError && <p role="alert">{refusalMessage(dispose.error)}</p>}
    </form>
  );
}
