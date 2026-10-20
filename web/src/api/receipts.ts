import { apiGet, apiPost } from "./client";
import type { Money } from "./money";

// Wire shapes of the receipt routes (api/internal/httpapi/receipts.go,
// TYRE-283). The price list match, a receipt's moves and every refusal are
// migration 000059's; this shapes the request and unwraps the envelope.

// app.price_list_estimate's answer for one receive: the list's figure, the
// date it took effect, and whether the brand's own row answered or the
// size's (FR-CFG-041). Null when no row is in force, and when money is
// hidden from the actor.
export interface PriceEstimate {
  typicalPrice: Money;
  effectiveFrom: string;
  brandSpecific: boolean;
}

// Asked with exactly what the receive will send, so the figure shown is the
// figure app.receive_tyres accepts. A blank received date is the tenant's
// today, decided by the server (rule 6).
export function fetchPriceEstimate(q: {
  sizeId: string;
  patternId: string;
  brandId?: string;
  receivedDate?: string;
}): Promise<PriceEstimate | null> {
  const params = new URLSearchParams({ sizeId: q.sizeId, patternId: q.patternId });
  if (q.brandId) params.set("brandId", q.brandId);
  if (q.receivedDate) params.set("receivedDate", q.receivedDate);
  return apiGet<{ estimate: PriceEstimate | null }>(
    `/api/tyre-price-estimate?${params.toString()}`,
  ).then((body) => body.estimate);
}

// One receipt still waiting for its price: UNPRICED or ESTIMATED, since the
// other two states are final. Received date and the names are the receipt's
// own, as received; the counts and codes are its tyres'. unitPrice is
// absent when money is hidden from the actor and for an unpriced set.
export interface OpenReceipt {
  id: string;
  priceState: string;
  receivedDate: string;
  depotName: string | null;
  sizeName: string;
  brandName: string | null;
  patternName: string;
  quantity: number;
  inFleet: number;
  displayCodes: string[];
  unitPrice?: Money;
}

export function fetchOpenReceipts(): Promise<OpenReceipt[]> {
  return apiGet<{ receipts: OpenReceipt[] }>("/api/tyre-receipts/open").then(
    (body) => body.receipts,
  );
}

// What a move did to the set: tyres priced, and tyres that had left the
// fleet and kept what they had.
export interface MoveResult {
  priced: number;
  leftFleet: number;
}

// Money stays a string to the wire (rule 2); the database casts, rounds and
// refuses.
export function recordReceiptInvoice(
  id: string,
  body: { price: string; invoiceNumber?: string; invoiceDate?: string },
): Promise<MoveResult> {
  return apiPost<MoveResult>(`/api/tyre-receipts/${id}/invoice`, body);
}

export function applyReceiptListPrice(id: string): Promise<MoveResult> {
  return apiPost<MoveResult>(`/api/tyre-receipts/${id}/list-price`, {});
}

export function keepReceiptEstimate(id: string): Promise<void> {
  return apiPost<void>(`/api/tyre-receipts/${id}/keep-estimate`, {});
}
