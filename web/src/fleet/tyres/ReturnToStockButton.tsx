import { refusalMessage } from "../../api/refusal";
import { returnTyreToStock, type Tyre } from "../../api/tyres";
import { useFormMutation } from "../useFormMutation";

// app.return_tyre_to_stock reaches TY012 (no such tyre, or the wrong state
// to restock) and TY014 (an input this surface does not accept).
const RETURN_WORDING = {
  speakable: ["TY012", "TY014"],
  forbidden: "You do not have permission to return a tyre to stock.",
  fallback:
    "The tyre could not be returned to stock. Try again, or call support if it keeps happening.",
};

// FR-FIT-013: a casing comes back from the retreader or the breakdown
// supplier. No depot picker this slice (D2) — the tyre keeps its
// current_depot_id, so this only says the fleet has it back, never that it
// moved; a location correction is a separate surface. The body posted is
// always {} — the server accepts an empty JSON body and refuses no body at
// all (an empty stream), so returnTyreToStock's own {} default carries this.
export function ReturnToStockButton({ tyre, tenantKey }: { tyre: Tyre; tenantKey: string }) {
  const ret = useFormMutation<undefined, void>({
    mutate: () => returnTyreToStock(tyre.id, {}),
    invalidate: [["tyres", tenantKey]],
  });

  return (
    <span className="tyres-row-form">
      <button
        className="btn-primary btn-compact"
        type="button"
        disabled={ret.isPending}
        onClick={() => ret.submit(undefined)}
      >
        {ret.isPending ? "Returning…" : "Return to stock"}
      </button>

      {ret.isSuccess && <p role="status">{`${tyre.displayCode} was returned to stock.`}</p>}
      {ret.error !== null && <p role="alert">{refusalMessage(ret.error, RETURN_WORDING)}</p>}
    </span>
  );
}
