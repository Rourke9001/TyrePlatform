import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";

import { getDevTenantId } from "../../api/devTenant";
import { type Money, moneyText, useCurrency } from "../../api/money";
import {
  fetchTyreRegister,
  isDisposed,
  type Destination,
  type Tyre,
  type TyreRegisterFilters,
} from "../../api/tyres";
import { useCan } from "../../auth/actorContext";
import { basisLabel, costSourceLabel, tyreStateLabel } from "../../domain/vocabulary";
import { formatCount } from "../../format/numbers";
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
import { TableScroll } from "../../ui/DataTable";
import { byNaturalCode } from "../unit/naturalOrder";
import { tyresKey } from "../unit/queryKeys";
import { CostForm } from "./CostForm";
import { DispatchForm } from "./DispatchForm";
import { DisposeForm } from "./DisposeForm";
import { MarkCodeForm } from "./MarkCodeForm";
import { ReturnToStockButton } from "./ReturnToStockButton";
import "../fleet.css";

function MoneyCell({
  value,
  basis,
  currency,
}: {
  value: Money | undefined;
  basis: string;
  currency: string;
}) {
  return (
    <td data-align="right" data-mono="true">
      {moneyText(value ?? null, true, currency)}
      {value !== undefined && (
        <>
          {" "}
          <span className="fleet-basis">{basis}</span>
        </>
      )}
    </td>
  );
}

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
  | { kind: "cost"; code: string }
  | { kind: "mark"; codes: string[] };

function actedMessage(acted: ActedOn): string {
  switch (acted.kind) {
    case "return":
      return `Tyre ${acted.code} was returned to stock.`;
    case "dispose":
      return `Tyre ${acted.code} was disposed of.`;
    case "cost":
      return `Tyre ${acted.code}'s cost was recorded.`;
    case "mark":
      return acted.codes.length === 1
        ? `Code ${acted.codes[0] ?? ""} recorded as marked.`
        : `${formatCount(acted.codes.length)} codes recorded as marked: ${acted.codes.join(", ")}.`;
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
  const [codesToMark, setCodesToMark] = useState(false);
  const [codeInput, setCodeInput] = useState("");
  const [dateInput, setDateInput] = useState("");
  const [lookup, setLookup] = useState<{ code: string; on: string } | null>(null);
  const [acted, setActed] = useState<ActedOn | null>(null);

  // code+on take over from both toggles when a lookup is active
  // (FR-TYR-042 resolves by date, not by a backlog filter). The same
  // precedence listTyres itself applies server-side. The query key carries
  // this object as the third element tyresKey's comment
  // (unit/queryKeys.ts) describes.
  const filters: TyreRegisterFilters = lookup
    ? { code: lookup.code, on: lookup.on }
    : { awaitingCost, codesToMark };

  const tyres = useQuery({
    queryKey: [...tyresKey(tenantKey), filters],
    queryFn: () => fetchTyreRegister(filters),
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
    ? [...tyres.data.tyres].sort((a, b) => byNaturalCode(a.displayCode, b.displayCode))
    : [];

  // A receipt another loaded row still waits on can be marked in one go.
  // This reads the flags the server sent, so it is no second copy of the
  // queue's rule (TYRE-99).
  function sharesPendingReceipt(t: Tyre): boolean {
    return (
      t.receiptId !== null &&
      rows.some((o) => o.id !== t.id && o.codePending && o.receiptId === t.receiptId)
    );
  }

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
            {/* Gated on LogRetread, since an actor who cannot log a return
                has nothing to do on that screen. */}
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
        <div className="tyres-filters">
          <Checkbox
            label="Awaiting cost only"
            checked={awaitingCost}
            onChange={(e) => {
              setAwaitingCost(e.target.checked);
              setActed(null);
            }}
          />
          <Checkbox
            label={
              tyres.isSuccess
                ? `Codes to mark (${formatCount(tyres.data.codesToMark)})`
                : "Codes to mark"
            }
            checked={codesToMark}
            onChange={(e) => {
              setCodesToMark(e.target.checked);
              setActed(null);
            }}
          />
        </div>
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
          <TableScroll label="Tyres table">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Sidewall code</th>
                  <th scope="col">Size</th>
                  <th scope="col">Brand</th>
                  <th scope="col">Pattern</th>
                  <th scope="col">State</th>
                  <th scope="col">Retreads</th>
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
                    <td>
                      {t.codePending ? (
                        <>
                          <p className="fleet-hint">Code not yet on the sidewall</p>
                          <MarkCodeForm
                            tyre={t}
                            tenantKey={tenantKey}
                            wholeReceipt={sharesPendingReceipt(t)}
                            onMarked={(marked) =>
                              setActed({
                                kind: "mark",
                                codes: marked
                                  .map((m) => m.displayCode)
                                  .sort((a, b) => byNaturalCode(a, b)),
                              })
                            }
                          />
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td data-mono="true">{t.sizeName ?? "—"}</td>
                    <td>{t.brandName ?? "—"}</td>
                    <td>{t.patternName ?? "—"}</td>
                    <td>{tyreStateLabel(t.state)}</td>
                    <td data-align="right" data-mono="true">
                      {formatCount(t.retreadCount)}
                    </td>
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
                    {/* NFR-PRO-001: each figure beside what it rests on; the
                        price and the rate derived from it share the cost
                        source (BR-VAL-002), the casing its valuation's basis
                        (BR-VAL-004, U253). An absent figure reads "Not
                        valued" (NFR-PRO-002). */}
                    {canSeeMoney && (
                      <MoneyCell
                        value={t.purchasePrice}
                        basis={costSourceLabel(t.costSource ?? "UNKNOWN")}
                        currency={currency}
                      />
                    )}
                    {canSeeMoney && (
                      <MoneyCell
                        value={t.randPerMm}
                        basis={costSourceLabel(t.costSource ?? "UNKNOWN")}
                        currency={currency}
                      />
                    )}
                    {canSeeMoney && (
                      <MoneyCell
                        value={t.casingValue}
                        basis={basisLabel(t.casingBasis ?? "UNVALUED")}
                        currency={currency}
                      />
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
          </TableScroll>
        </Card>
      )}
    </section>
  );
}
