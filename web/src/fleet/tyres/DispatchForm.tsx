import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { refusalMessage } from "../../api/refusal";
import { dispatchTyre, type Tyre } from "../../api/tyres";
import { fetchDepots } from "../../api/units";
import { useFormMutation } from "../useFormMutation";

// app.dispatch_tyre reaches TY012 (no such tyre), TY014 (an input this
// surface does not accept — the wrong state, the wrong depot type) and TY015
// (BR-FIT-009's retread cap), rendered verbatim since TY015's own sentence —
// "a purchase, not a retread candidate" — is the whole content of the
// refusal (NFR-USE-005).
const DISPATCH_WORDING = {
  speakable: ["TY012", "TY014", "TY015"],
  forbidden: "You do not have permission to dispatch a tyre.",
  fallback: "The tyre could not be dispatched. Try again, or call support if it keeps happening.",
};

type Destination = "AT_RETREADER" | "AT_BREAKDOWN_SUPPLIER";

const DESTINATIONS: { value: Destination; label: string }[] = [
  { value: "AT_RETREADER", label: "Retreader" },
  { value: "AT_BREAKDOWN_SUPPLIER", label: "Breakdown supplier" },
];

// app.dispatch_tyre's own destination-to-depot-type mapping (000033): a
// depot picker must offer only depots the write will accept, not every
// depot in the fleet.
function depotTypeFor(destination: Destination): string {
  return destination === "AT_RETREADER" ? "RETREADER" : "BREAKDOWN_SUPPLIER";
}

// FR-FIT-011/012: a REMOVED casing leaves the workshop for the retreader or
// the breakdown supplier. Which destinations a depot's type may receive,
// the BR-FIT-009 retread cap and which state a casing must be in to go are
// all app.dispatch_tyre's alone, forwarded verbatim (ADR-0013 decision 5).
export function DispatchForm({ tyre, tenantKey }: { tyre: Tyre; tenantKey: string }) {
  const [destination, setDestination] = useState<Destination | "">("");
  const [depotId, setDepotId] = useState("");
  const [sentOn, setSentOn] = useState("");

  const depots = useQuery({
    queryKey: ["depots", tenantKey, destination],
    queryFn: () => fetchDepots(depotTypeFor(destination as Destination)),
    enabled: destination !== "",
  });

  const dispatch = useFormMutation({
    mutate: (vars: { destination: string; depotId: string; sentOn?: string }) =>
      dispatchTyre(tyre.id, vars),
    invalidate: [["tyres", tenantKey], ["retread-jobs"]],
    onSuccess: () => {
      setDestination("");
      setDepotId("");
      setSentOn("");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (destination === "" || depotId === "") return;
    dispatch.submit({
      destination,
      depotId,
      // Empty stays unsent rather than "": the server defaults sentOn to
      // the tenant's own today (units.go's own comment), which an empty
      // string is not a stand-in for.
      sentOn: sentOn === "" ? undefined : sentOn,
    });
  }

  return (
    <form onSubmit={submit} className="tyres-row-form">
      <div role="radiogroup" aria-label="Destination">
        {DESTINATIONS.map((d) => (
          <label key={d.value}>
            <input
              type="radio"
              name={`destination-${tyre.id}`}
              value={d.value}
              checked={destination === d.value}
              onChange={() => {
                setDestination(d.value);
                setDepotId("");
              }}
            />
            {d.label}
          </label>
        ))}
      </div>

      {destination !== "" && (
        <select
          aria-label={`Depot for ${tyre.displayCode}`}
          value={depotId}
          onChange={(e) => setDepotId(e.target.value)}
        >
          <option value="">Choose…</option>
          {(depots.data ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
      )}

      <input
        aria-label="Sent on"
        type="date"
        value={sentOn}
        onChange={(e) => setSentOn(e.target.value)}
      />

      <button
        className="btn-primary btn-compact"
        type="submit"
        disabled={destination === "" || depotId === "" || dispatch.isPending}
      >
        {dispatch.isPending ? "Dispatching…" : "Dispatch"}
      </button>

      {dispatch.isSuccess && <p role="status">{`${tyre.displayCode} was dispatched.`}</p>}
      {dispatch.error !== null && (
        <p role="alert">{refusalMessage(dispatch.error, DISPATCH_WORDING)}</p>
      )}
    </form>
  );
}
