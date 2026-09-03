import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";

import { getDevTenantId } from "../../api/devTenant";
import { fetchTyres, isDisposed, type Tyre } from "../../api/tyres";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { byNaturalCode } from "../unit/naturalOrder";
import { CostForm } from "./CostForm";
import { DispatchForm } from "./DispatchForm";
import { DisposeForm } from "./DisposeForm";
import { ReturnToStockButton } from "./ReturnToStockButton";
import "../fleet.css";

// fetchTyres's own optional-filter shape, not redeclared: the two are one
// contract, and the query key below carries this object verbatim so a query
// key idiom used elsewhere (AddUnit.tsx) applies unchanged here.
type TyreFilters = NonNullable<Parameters<typeof fetchTyres>[0]>;

// FR-TYR-043: two active tyres carrying one code is a state the register
// must surface, never resolve on the user's behalf (ADR-0008 rule 3).
function multiMatchNote(count: number, code: string): string {
  const subject = count === 2 ? "Two tyres" : `${count} tyres`;
  return `${subject} carried code ${code} on that date — resolve by eye, the system never guesses.`;
}

// The last write this screen's rows made, held here rather than inside the
// row that made it: every one of them moves the tyre off the state or the
// flag that offered the control, the refetch swaps that cell for a different
// one, and a line left inside the old cell would show for one round-trip and
// vanish before anyone could read it (NFR-USE-010).
type ActedOn =
  | { kind: "dispatch"; code: string; destination: "AT_RETREADER" | "AT_BREAKDOWN_SUPPLIER" }
  | { kind: "return"; code: string }
  | { kind: "dispose"; code: string }
  | { kind: "cost"; code: string };

function actedMessage(acted: ActedOn): string {
  switch (acted.kind) {
    case "return":
      return `Tyre ${acted.code} was returned to stock.`;
    case "dispose":
      return `Tyre ${acted.code} was disposed of.`;
    case "cost":
      return `Tyre ${acted.code}'s cost was recorded.`;
    default: {
      const place =
        acted.destination === "AT_RETREADER" ? "the retreader" : "the breakdown supplier";
      return `Tyre ${acted.code} was sent to ${place}.`;
    }
  }
}

// Row actions by tyre.state (TYRE-92/93 D7, U1/U2): which write a row
// offers is a fact about where the casing currently sits, not a flag this
// screen invents. Every transition rule enforced past this point belongs to
// the write it fronts (app.dispatch_tyre, app.return_tyre_to_stock,
// app.dispose_tyre) — this only decides which form the state makes
// reachable. onActed carries a row's success up to the screen-level
// confirmation (see ActedOn above).
function rowActions(t: Tyre, tenantKey: string, onActed: (acted: ActedOn) => void) {
  if (isDisposed(t.state)) return "—";
  switch (t.state) {
    case "IN_STOCK":
      return (
        <DisposeForm
          tyre={t}
          tenantKey={tenantKey}
          onSuccess={() => onActed({ kind: "dispose", code: t.displayCode })}
        />
      );
    case "REMOVED":
      return (
        <div className="tyres-row-actions">
          <ReturnToStockButton
            tyre={t}
            tenantKey={tenantKey}
            onSuccess={() => onActed({ kind: "return", code: t.displayCode })}
          />
          <DispatchForm
            tyre={t}
            tenantKey={tenantKey}
            onSuccess={(destination) =>
              onActed({ kind: "dispatch", code: t.displayCode, destination })
            }
          />
          <DisposeForm
            tyre={t}
            tenantKey={tenantKey}
            onSuccess={() => onActed({ kind: "dispose", code: t.displayCode })}
          />
        </div>
      );
    case "AT_BREAKDOWN_SUPPLIER":
      // No disposal reaches this state directly: app.dispose_tyre (000031)
      // refuses SCRAPPED and LOST alike unless the tyre is IN_STOCK or
      // REMOVED. The path today is return to stock, then dispose from
      // IN_STOCK — this offers only the write that actually succeeds.
      return (
        <ReturnToStockButton
          tyre={t}
          tenantKey={tenantKey}
          onSuccess={() => onActed({ kind: "return", code: t.displayCode })}
        />
      );
    case "AT_RETREADER":
      // Tyre carries no depot field: the register cannot name which
      // retreader without one, so this reads generically rather than a Go
      // field added for one row's text.
      return "At the retreader — log the return under Retreads";
    case "FITTED":
      return "Fitted — see the unit";
    default:
      return "—";
  }
}

export function TyreList() {
  const tenantKey = getDevTenantId() ?? "default";
  const canSeeMoney = useCan("ViewValuation");
  const canLogRetread = useCan("LogRetread");
  const asOf = useTenantDate();

  const [awaitingCost, setAwaitingCost] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [dateInput, setDateInput] = useState("");
  const [lookup, setLookup] = useState<{ code: string; on: string } | null>(null);
  const [acted, setActed] = useState<ActedOn | null>(null);

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
    // A confirmation names a specific past write, unrelated to whichever
    // rows a lookup turns up; left standing, it would sit above a register
    // it does not describe (NFR-USE-010).
    setActed(null);
  }

  function clearLookup() {
    setLookup(null);
    setCodeInput("");
    setDateInput("");
    setActed(null);
  }

  const rows = tyres.isSuccess
    ? [...tyres.data].sort((a, b) => byNaturalCode(a.displayCode, b.displayCode))
    : [];

  return (
    <section aria-labelledby="tyres-heading" className="tyres">
      <div className="tyres-heading-row">
        <h1 className="page-title" id="tyres-heading">
          Tyres
        </h1>
        {/* The register's only route to intake (FR-TYR-040): ReceiveTyre is
            otherwise reachable by URL alone, and a screen someone cannot find
            their way to might as well not exist. */}
        <Link to="/fleet/tyres/new">Receive tyres</Link>
        {/* The queue's only discoverable entry point (routes and nav are
            Task 15's) — gated on LogRetread since an actor who cannot log a
            return has nothing to do on that screen. */}
        {canLogRetread && <Link to="/fleet/tyres/retreads">Retreads</Link>}
      </div>

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
        <button className="btn-primary" type="submit">
          Find tyre
        </button>
        {lookup && (
          <button className="btn-primary" type="button" onClick={clearLookup}>
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

      {/* One confirmation region for every row write — see ActedOn above
          for why this cannot live inside the row. */}
      {acted !== null && <p role="status">{actedMessage(acted)}</p>}

      {tyres.isPending && <p>Loading…</p>}

      {tyres.isError && (
        <div className="note-card" role="alert">
          <h2>Tyres didn&apos;t load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <button className="btn-primary" type="button" onClick={() => void tyres.refetch()}>
            Retry
          </button>
        </div>
      )}

      {tyres.isSuccess && rows.length === 0 && <p className="note-card">No tyres match.</p>}

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
              <th scope="col">Set cost</th>
              {canSeeMoney && <th scope="col">Purchase price</th>}
              {canSeeMoney && <th scope="col">Rand/mm</th>}
              {canSeeMoney && <th scope="col">Casing value</th>}
              <th scope="col">Actions</th>
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
                <td>
                  {t.awaitingCost ? (
                    <CostForm
                      tyre={t}
                      tenantKey={tenantKey}
                      onSuccess={() => setActed({ kind: "cost", code: t.displayCode })}
                    />
                  ) : (
                    "—"
                  )}
                </td>
                {canSeeMoney && <td>{t.purchasePrice ? `R ${t.purchasePrice}` : "—"}</td>}
                {canSeeMoney && <td>{t.randPerMm ? `R ${t.randPerMm}` : "—"}</td>}
                {canSeeMoney && <td>{t.casingValue ? `R ${t.casingValue}` : "—"}</td>}
                {/* No active-only filter exists on this register (TYRE-91):
                    a disposed row stays visible, and a state's own form's
                    refusal for it (a *_tyre invalid-transition message)
                    reads as advice for a tyre that is not reachable from
                    here. rowActions hides every form once the state is
                    terminal, matching the Set-cost column's dash pattern. */}
                <td>{rowActions(t, tenantKey, setActed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
