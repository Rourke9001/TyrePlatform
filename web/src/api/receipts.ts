import { apiGet } from "./client";
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
