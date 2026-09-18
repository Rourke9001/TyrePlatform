import { refusalMessage } from "../../api/refusal";
import { returnTyreToStock, type Tyre } from "../../api/tyres";
import { tyresKey } from "../unit/queryKeys";
import { useFormMutation } from "../useFormMutation";

// TY012 only: this button never sends a depotId, so TY014's two depot-gated
// branches (both `p_depot IS NOT NULL`) can never fire from here.
const RETURN_WORDING = {
  speakable: ["TY012"],
  forbidden: "You do not have permission to return a tyre to stock.",
  fallback:
    "The tyre could not be returned to stock. Try again, or call support if it keeps happening.",
};

// FR-FIT-013: the casing comes back, no depot picker this slice (D2); the
// tyre keeps its current_depot_id, so this says the fleet has it back, not
// that it moved. Confirmation lives at the register (ActedOn, TyreList.tsx,
// NFR-USE-010).
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
    invalidate: [tyresKey(tenantKey)],
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
