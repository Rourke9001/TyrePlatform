import type { MoveResult } from "../../api/receipts";
import { plural } from "../../ui/vocabulary";

// A receipt's moves answer TY026 (a move its state does not allow), TY012
// (no such receipt in this fleet) and TY013 (a tyre on it that cannot be
// rated), each rendered verbatim (000059, ADR-0012).
export const RECEIPT_WORDING = {
  speakable: ["TY026", "TY012", "TY013"],
  forbidden: "You do not have permission to price receipts.",
  fallback: "The receipt could not be updated. Try again, or call support if it keeps happening.",
};

// The confirmation for a whole set (spec D3). A tyre that has left the
// fleet keeps what it had: the estimate on a receipt priced from the list,
// nothing on one still unpriced.
export function moveMessage(
  move: "invoice" | "list-price",
  result: MoveResult,
  wasEstimated: boolean,
): string {
  const lead = move === "invoice" ? "Invoice recorded." : "List price applied.";
  if (result.priced === 0) {
    return `${lead} No tyre on this receipt is still in the fleet, so none was priced.`;
  }
  const priced = `${lead} ${plural(result.priced, "tyre", "tyres")} priced.`;
  if (result.leftFleet === 0) return priced;
  const one = result.leftFleet === 1;
  const kept = wasEstimated
    ? one
      ? "keeps its estimate"
      : "keep their estimate"
    : one
      ? "stays unpriced"
      : "stay unpriced";
  return `${priced} ${plural(result.leftFleet, "tyre", "tyres")} ${one ? "has" : "have"} left the fleet and ${kept}.`;
}
