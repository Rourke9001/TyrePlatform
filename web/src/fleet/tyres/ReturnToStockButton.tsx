import { refusalMessage } from "../../api/refusal";
import { returnTyreToStock, type Tyre } from "../../api/tyres";
import { useFormMutation } from "../useFormMutation";

// TY012 only (no such tyre, or app.return_tyre_to_stock's own state guard —
// a tyre that is not REMOVED/AT_BREAKDOWN_SUPPLIER): this button never sends
// a depotId, so app.return_tyre_to_stock's TY014 branches — both gated on
// `p_depot IS NOT NULL` — can never fire from here (refusal.ts's own rule:
// list only what a screen's endpoints can actually raise).
const RETURN_WORDING = {
  speakable: ["TY012"],
  forbidden: "You do not have permission to return a tyre to stock.",
  fallback:
    "The tyre could not be returned to stock. Try again, or call support if it keeps happening.",
};

// FR-FIT-013: a casing comes back from the retreader or the breakdown
// supplier. No depot picker this slice (D2) — the tyre keeps its
// current_depot_id, so this only says the fleet has it back, never that it
// moved; a location correction is a separate surface. This button sends {}
// itself — there is no default body to fall back on — and app.
// return_tyre_to_stock's own NULL branch (000033) is what leaves the casing
// at the depot it already has.
//
// onSuccess names nothing further: the confirmation this write earns lives
// at the register, since a successful return moves the tyre off REMOVED/
// AT_BREAKDOWN_SUPPLIER and this row unmounts on the refetch before anyone
// could read a line left inside it.
export function ReturnToStockButton({
  tyre,
  tenantKey,
  onSuccess,
}: {
  tyre: Tyre;
  tenantKey: string;
  onSuccess?: () => void;
}) {
  const ret = useFormMutation<undefined, void>({
    mutate: () => returnTyreToStock(tyre.id, {}),
    invalidate: [["tyres", tenantKey]],
    onSuccess: () => onSuccess?.(),
  });

  return (
    <>
      <button
        className="btn-primary btn-compact"
        type="button"
        disabled={ret.isPending}
        onClick={() => ret.submit(undefined)}
      >
        {ret.isPending ? "Returning…" : "Return to stock"}
      </button>

      {ret.error !== null && <p role="alert">{refusalMessage(ret.error, RETURN_WORDING)}</p>}
    </>
  );
}
