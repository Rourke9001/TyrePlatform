import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { refusalMessage } from "../../api/refusal";
import { dispatchTyre, type Tyre } from "../../api/tyres";
import { fetchDepots } from "../../api/units";
import { depotsKey, retreadJobsKey } from "../unit/queryKeys";
import { useFormMutation } from "../useFormMutation";

// app.dispatch_tyre reaches TY012 (no such tyre, or its own REMOVED-only
// state guard), TY014 (the depot: none, the wrong type, or inactive; or a
// sentOn in the future — 000033's depot/date branches) and TY015 (BR-FIT-009's
// retread cap), rendered verbatim since TY015's own sentence — "a purchase,
// not a retread candidate" — is the whole content of the refusal
// (NFR-USE-005).
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
// depot in the fleet. Accepts the unpicked "" so the query below needs no
// cast to call it — the query itself never runs against that branch
// (`enabled: destination !== ""`).
function depotTypeFor(destination: Destination | ""): string {
  if (destination === "AT_RETREADER") return "RETREADER";
  if (destination === "AT_BREAKDOWN_SUPPLIER") return "BREAKDOWN_SUPPLIER";
  return "";
}

// FR-FIT-011/012: a REMOVED casing leaves the workshop for the retreader or
// the breakdown supplier. Which destinations a depot's type may receive,
// the BR-FIT-009 retread cap and which state a casing must be in to go are
// all app.dispatch_tyre's alone, forwarded verbatim (ADR-0013 decision 5).
//
// onSuccess names the destination a caller dispatched to: the confirmation
// this write earns lives at the register, since a successful dispatch moves
// the tyre off REMOVED and this form's own row unmounts on the refetch
// before anyone could read a line left inside it.
export function DispatchForm({
  tyre,
  tenantKey,
  onSuccess,
}: {
  tyre: Tyre;
  tenantKey: string;
  onSuccess?: (destination: Destination) => void;
}) {
  const [destination, setDestination] = useState<Destination | "">("");
  const [depotId, setDepotId] = useState("");
  const [sentOn, setSentOn] = useState("");

  const depots = useQuery({
    queryKey: [...depotsKey(tenantKey), destination],
    queryFn: () => fetchDepots(depotTypeFor(destination)),
    enabled: destination !== "",
  });

  const dispatch = useFormMutation({
    mutate: (vars: { destination: string; depotId: string; sentOn?: string }) =>
      dispatchTyre(tyre.id, vars),
    invalidate: [["tyres", tenantKey], retreadJobsKey(tenantKey)],
    onSuccess: () => {
      if (destination !== "") onSuccess?.(destination);
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
      // Empty stays unsent rather than "": an absent sentOn reaches
      // app.dispatch_tyre's own tenant_today default (dispatchTyreRequest's
      // own comment, tyres.go), which an empty string is not a stand-in for.
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
                // Cleared, not carried over: a depot valid for the previous
                // destination's type is not necessarily valid for this one
                // (app.dispatch_tyre's type check would refuse it as TY014).
                setDepotId("");
              }}
            />
            {d.label}
          </label>
        ))}
      </div>

      {destination !== "" && depots.isError && (
        <div className="note-card" role="alert">
          <h2>Depots didn&apos;t load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <button className="btn-primary" type="button" onClick={() => void depots.refetch()}>
            Retry
          </button>
        </div>
      )}

      {destination !== "" && !depots.isError && (
        <select
          aria-label={`Depot for ${tyre.displayCode}`}
          value={depotId}
          onChange={(e) => setDepotId(e.target.value)}
        >
          <option value="" disabled={depots.isPending}>
            {depots.isPending ? "Loading…" : "Choose…"}
          </option>
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

      {dispatch.error !== null && (
        <p role="alert">{refusalMessage(dispatch.error, DISPATCH_WORDING)}</p>
      )}
    </form>
  );
}
