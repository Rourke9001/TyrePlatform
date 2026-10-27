import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";

import { getDevTenantId } from "../../api/devTenant";
import { formatMoney, useCurrency } from "../../api/money";
import { fetchTyres, isDisposed, type Destination, type Tyre } from "../../api/tyres";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { Checkbox } from "../../ui/Checkbox";
import { Field } from "../../ui/Field";
import { PlusIcon } from "../../ui/icons/Plus";
import { RefreshIcon } from "../../ui/icons/Refresh";
import { PageHeader } from "../../ui/PageHeader";
import { TextInput } from "../../ui/TextInput";
import { byNaturalCode } from "../unit/naturalOrder";
import { tyresKey } from "../unit/queryKeys";
import { CostForm } from "./CostForm";
import { DispatchForm } from "./DispatchForm";
import { DisposeForm } from "./DisposeForm";
import { ReturnToStockButton } from "./ReturnToStockButton";
import "../fleet.css";

// fetchTyres's own optional-filter shape, not redeclared: the two are one
// contract, and the query key below carries this object verbatim as the third
// element tyresKey's own comment (unit/queryKeys.ts) describes.
type TyreFilters = NonNullable<Parameters<typeof fetchTyres>[0]>;

// FR-TYR-043: two active tyres carrying one code is a state the register
// must surface, never resolve on the user's behalf (ADR-0008 rule 3).
function multiMatchNote(count: number, code: string): string {
  const subject = count === 2 ? "Two tyres" : `${count} tyres`;
  return `${subject} carried code ${code} on that date. Resolve by eye, the system never guesses.`;
}

// The last write this screen's rows made, held here not in the row: every
// write moves the tyre off the state that offered the control, and a
// confirmation left in the swapped-away cell would show for one
// round-trip and vanish (NFR-USE-010).
type ActedOn =
  | { kind: "dispatch"; code: string; destination: Destination }
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

// Row actions by tyre.state (TYRE-92/93, D7, U1/U2): which write a row
// offers is a fact about where the casing sits, not a flag this screen
// invents. Every transition rule belongs to the write it fronts.
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
      // No disposal reaches AT_BREAKDOWN_SUPPLIER directly (app.dispose_tyre,
      // 000031); the path is return to stock, then dispose from IN_STOCK.
      // This offers only the write that actually succeeds.
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
      return "At the retreader, log the return under Retreads";
    case "FITTED":
      return "Fitted, see the unit";
    default:
      return "—";
  }
}

export function TyreList() {
  const tenantKey = getDevTenantId() ?? "default";
  const canSeeMoney = useCan("ViewValuation");
  const currency = useCurrency();
  const canLogRetread = useCan("LogRetread");
  const asOf = useTenantDate();

  const [awaitingCost, setAwaitingCost] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [dateInput, setDateInput] = useState("");
  const [lookup, setLookup] = useState<{ code: string; on: string } | null>(null);
  const [acted, setActed] = useState<ActedOn | null>(null);

  // code+on take over from the awaiting-cost toggle when a lookup is active
  // (FR-TYR-042 resolves by date, not by the backlog filter). The same
  // precedence listTyres itself applies server-side.
  const filters: TyreFilters = lookup ? { code: lookup.code, on: lookup.on } : { awaitingCost };

  const tyres = useQuery({
    queryKey: [...tyresKey(tenantKey), filters],
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
    <section aria-labelledby="tyres-heading" className="fleet-page tr-stack">
      {/* Heading id: see PageHeader's title prop. */}
      <PageHeader
        title={<span id="tyres-heading">Tyres</span>}
        actions={
          <>
            {/* The register's only route to intake (FR-TYR-040): ReceiveTyre
                is otherwise reachable by URL alone, and a screen someone
                cannot find their way to might as well not exist. */}
            <Button to="/fleet/tyres/new" variant="primary" icon={PlusIcon}>
              Receive tyres
            </Button>
            {/* The queue's only discoverable entry point, gated on LogRetread
                since an actor who cannot log a return has nothing to do on
                that screen. */}
            {canLogRetread && (
              <Button to="/fleet/tyres/retreads" icon={RefreshIcon}>
                Retreads
              </Button>
            )}
          </>
        }
      />

      <form className="fleet-toolbar" onSubmit={submitLookup}>
        <Field label="Display code">
          <TextInput
            id="lookup-code"
            mono
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            required
          />
        </Field>
        <Field label="As of date">
          <TextInput
            id="lookup-date"
            type="date"
            value={dateInput}
            onChange={(e) => setDateInput(e.target.value)}
            required
          />
        </Field>
        <Button type="submit">Find tyre</Button>
        {lookup && <Button onClick={clearLookup}>Show full register</Button>}
      </form>

      {!lookup && (
        <Checkbox
          label="Awaiting cost only"
          checked={awaitingCost}
          onChange={(e) => {
            setAwaitingCost(e.target.checked);
            setActed(null);
          }}
        />
      )}

      {lookup && tyres.isSuccess && rows.length > 1 && (
        <p className="tyres-lookup-note">{multiMatchNote(rows.length, lookup.code)}</p>
      )}

      {/* One confirmation region for every row write. See ActedOn above
          for why this cannot live inside the row. */}
      {acted !== null && <p role="status">{actedMessage(acted)}</p>}

      {tyres.isPending && <p>Loading…</p>}

      {tyres.isError && (
        <Banner
          tone="critical"
          title={<h2 className="fleet-banner-heading">Tyres didn&apos;t load</h2>}
          action={<Button onClick={() => void tyres.refetch()}>Retry</Button>}
        >
          The server could not be reached. Check your connection, then retry.
        </Banner>
      )}

      {tyres.isSuccess && rows.length === 0 && <p className="fleet-note">No tyres match.</p>}

      {tyres.isSuccess && rows.length > 0 && (
        <Card padding="none">
          <div className="fleet-table-wrap">
            <table className="fleet-table">
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
                  {canSeeMoney && <th scope="col">Cost per mm</th>}
                  {canSeeMoney && <th scope="col">Casing value</th>}
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <th scope="row" data-mono="true">
                      {t.displayCode}
                    </th>
                    <td data-mono="true">{t.sizeName ?? "—"}</td>
                    <td>{t.brandName ?? "—"}</td>
                    <td>{t.patternName ?? "—"}</td>
                    <td>{t.state}</td>
                    <td data-nowrap="true">
                      {t.receivedDate ? asOf(t.receivedDate) : "Not received"}
                    </td>
                    <td>{t.awaitingCost ? "Yes" : "No"}</td>
                    <td>
                      {/* FR-CFG-041: a received tyre is priced with its set,
                          on its receipt; set_tyre_cost refuses it alone. */}
                      {t.awaitingCost && t.receiptId !== null ? (
                        <Link to="/fleet/tyres/receipts">Price it on its receipt</Link>
                      ) : t.awaitingCost ? (
                        <CostForm
                          tyre={t}
                          tenantKey={tenantKey}
                          onSuccess={() => setActed({ kind: "cost", code: t.displayCode })}
                        />
                      ) : (
                        "—"
                      )}
                    </td>
                    {canSeeMoney && (
                      <td data-align="right" data-mono="true">
                        {t.purchasePrice ? formatMoney(t.purchasePrice, currency) : "—"}
                      </td>
                    )}
                    {canSeeMoney && (
                      <td data-align="right" data-mono="true">
                        {t.randPerMm ? formatMoney(t.randPerMm, currency) : "—"}
                      </td>
                    )}
                    {canSeeMoney && (
                      <td data-align="right" data-mono="true">
                        {t.casingValue ? formatMoney(t.casingValue, currency) : "—"}
                      </td>
                    )}
                    {/* No active-only filter on this register (TYRE-91): a
                        disposed row stays visible, so rowActions hides every
                        form once the state is terminal, matching the Set-cost
                        column's dash. */}
                    <td>{rowActions(t, tenantKey, setActed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </section>
  );
}
