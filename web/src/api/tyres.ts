import { apiGet, apiPost } from "./client";

// Wire shapes of the tyre register (api/internal/httpapi/tyres.go, TYRE-91).
// Tyre mirrors the server's projection exactly, so a screen that just
// received or costed a tyre holds the same shape it would have read from the
// register. The request shapes carry only what a screen actually sends —
// receiveTyresRequest accepts more, and a field is added here when something
// produces it, not before.

// Money fields carry the server's own omission: absent (never null) unless
// the actor holds ViewValuation, or the tyre has none recorded yet
// (CFL-002's awaiting-cost backlog). Kept as optional strings, never
// numbers — money over the wire is always a string (web/CLAUDE.md).
export interface Tyre {
  id: string;
  displayCode: string;
  state: string;
  status: string;
  retreadCount: number;
  sizeName: string | null;
  brandName: string | null;
  patternName: string | null;
  receivedDate: string | null;
  awaitingCost: boolean;
  purchasePrice?: string;
  randPerMm?: string;
  casingValue?: string;
}

export interface ReceivedTyre {
  id: string;
  displayCode: string;
}

// FR-TYR-040's intake body. Every field but quantity is optional — most of
// what a tenant eventually knows about a tyre is often not known at
// receipt, which is exactly the awaiting-cost backlog CFL-002 names. The
// bound on quantity and the display-code policy refusal (D12/TY011) both
// belong to app.receive_tyres, not this shape.
export interface NewTyres {
  quantity?: number;
  displayCode?: string;
  purchasePrice?: string;
  costSource?: string;
}

// Mirrors app.tyre_state's disposal-reachable members (Appendix C's
// transition table). Which transitions are legal from which state is
// app.dispose_tyre's rule, not this client's.
export type Disposal = "SCRAPPED" | "SOLD" | "LOST";

export const DISPOSALS: { value: Disposal; label: string }[] = [
  { value: "SCRAPPED", label: "Scrapped" },
  { value: "SOLD", label: "Sold" },
  { value: "LOST", label: "Lost" },
];

// DISPOSALS' three values ARE the terminal states (app.dispose_tyre never
// transitions out of one); reused here rather than duplicated so the two
// lists cannot drift apart. Sits beside the sibling COST_SOURCES list below.
export function isDisposed(state: string): boolean {
  return DISPOSALS.some((d) => d.value === state);
}

// app.cost_source's third member, UNKNOWN, is app.receive_tyres' own default
// for an omitted source and never a choice a human makes, so it is not here.
// Shared by the receive form and the register's per-row cost form.
export type CostSource = "INVOICE" | "PRICE_LIST_ESTIMATE";

export const COST_SOURCES: { value: CostSource; label: string }[] = [
  { value: "INVOICE", label: "Invoice" },
  { value: "PRICE_LIST_ESTIMATE", label: "Price list estimate" },
];

// fetchTyres is the register read (FR-TYR-040..042). code and on together
// resolve a display code as of a date (a code is reissued after a tyre
// leaves the estate); awaitingCost narrows to the CFL-002 backlog. Neither
// pairing is validated here — the server owns that 400 (ADR-0013 decision
// 5) — this only shapes the query string and unwraps the envelope.
export function fetchTyres(opts?: {
  code?: string;
  on?: string;
  awaitingCost?: boolean;
}): Promise<Tyre[]> {
  const params = new URLSearchParams();
  if (opts?.code) params.set("code", opts.code);
  if (opts?.on) params.set("on", opts.on);
  if (opts?.awaitingCost) params.set("awaitingCost", "true");
  const qs = params.toString();
  return apiGet<{ tyres: Tyre[] }>(`/api/tyres${qs ? `?${qs}` : ""}`).then((body) => body.tyres);
}

export function receiveTyres(body: NewTyres): Promise<ReceivedTyre[]> {
  return apiPost<{ tyres: ReceivedTyre[] }>("/api/tyres", body).then((res) => res.tyres);
}

// setTyreCost is FR-TYR-041's costing step, the discharge for CFL-002's
// backlog. A second costing, a negative amount and TY012's RLS-hidden tyre
// are all app.set_tyre_cost's refusals, forwarded verbatim.
export function setTyreCost(
  tyreId: string,
  body: { price: string; source: string },
): Promise<void> {
  return apiPost<void>(`/api/tyres/${tyreId}/cost`, body);
}

// disposeTyre is the disposal step (Appendix C's transition table): scrap,
// sale or loss.
// The transition table, the reason/proceeds pairing and TY012's
// cross-tenant refusal are all app.dispose_tyre's, forwarded verbatim.
export function disposeTyre(
  tyreId: string,
  body: { disposal: Disposal; reason?: string; proceeds?: string },
): Promise<void> {
  return apiPost<void>(`/api/tyres/${tyreId}/dispose`, body);
}

// dispatchTyreResponse's own contract (tyres.go): retreadJobId is present
// only for the retreader destination, omitted rather than null for the
// breakdown-supplier branch that opens no job.
export interface DispatchResult {
  retreadJobId?: string;
}

// dispatchTyre is FR-FIT-011/012's write: a removed casing leaves the
// workshop for the retreader or the breakdown supplier. Which destinations a
// depot's type may receive, the BR-FIT-009 retread cap and which state a
// casing must be in to go are all app.dispatch_tyre's alone, forwarded
// verbatim.
export function dispatchTyre(
  tyreId: string,
  body: { destination: string; depotId: string; sentOn?: string },
): Promise<DispatchResult> {
  return apiPost<DispatchResult>(`/api/tyres/${tyreId}/dispatch`, body);
}

// returnTyreToStock is FR-FIT-013's receipt back, answering 204. depotId is
// optional: an absent one leaves the casing where the register already has
// it (tyres.go's own comment) — this says the fleet has it back, not that it
// moved. Which states restock and which depot types may hold stock are
// app.return_tyre_to_stock's rules.
export function returnTyreToStock(tyreId: string, body: { depotId?: string }): Promise<void> {
  return apiPost<void>(`/api/tyres/${tyreId}/return`, body);
}
