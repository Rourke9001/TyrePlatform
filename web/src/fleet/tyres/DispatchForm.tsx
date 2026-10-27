import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";

import { DESTINATIONS, dispatchTyre, type Destination, type Tyre } from "../../api/tyres";
import { fetchDepots } from "../../api/units";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { TextInput } from "../../ui/TextInput";
import { RefusalAlert } from "../RefusalAlert";
import { depotsKey, retreadJobsKey, tyresKey } from "../unit/queryKeys";
import { useFormMutation } from "../useFormMutation";

// app.dispatch_tyre reaches TY012, TY014 (depot/date branches) and TY015
// (BR-FIT-009's retread cap), rendered verbatim since TY015's own sentence
// is the whole content of the refusal (NFR-USE-005).
const DISPATCH_WORDING = {
  speakable: ["TY012", "TY014", "TY015"],
  forbidden: "You do not have permission to dispatch a tyre.",
  fallback: "The tyre could not be dispatched. Try again, or call support if it keeps happening.",
};

// app.dispatch_tyre's own destination-to-depot-type mapping (000033): only
// offer depots the write will accept. Accepts "" so the query below needs
// no cast; it never runs against that branch.
function depotTypeFor(destination: Destination | ""): string {
  if (destination === "AT_RETREADER") return "RETREADER";
  if (destination === "AT_BREAKDOWN_SUPPLIER") return "BREAKDOWN_SUPPLIER";
  return "";
}

// FR-FIT-011/012: a REMOVED casing leaves for the retreader or breakdown
// supplier; which destinations/states are valid is app.dispatch_tyre's
// alone (ADR-0013 decision 5). The confirmation lives at the register
// (ActedOn, TyreList.tsx, NFR-USE-010).
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
    invalidate: [tyresKey(tenantKey), retreadJobsKey(tenantKey)],
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
    <form onSubmit={submit} className="fleet-row-form">
      <div role="radiogroup" aria-label="Destination" className="fleet-choices">
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
        <Banner
          tone="critical"
          title={<h2 className="fleet-banner-heading">Depots didn&apos;t load</h2>}
          action={<Button onClick={() => void depots.refetch()}>Retry</Button>}
        >
          The server could not be reached. Check your connection, then retry.
        </Banner>
      )}

      {destination !== "" && !depots.isError && (
        // Native, not Select: its first option is disabled only while the
        // depots load, which Select's options cannot say.
        <select
          className="fleet-native-select"
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

      <TextInput
        aria-label="Sent on"
        type="date"
        value={sentOn}
        onChange={(e) => setSentOn(e.target.value)}
      />

      <Button type="submit" disabled={destination === "" || depotId === "" || dispatch.isPending}>
        {dispatch.isPending ? "Dispatching…" : "Dispatch"}
      </Button>

      <RefusalAlert error={dispatch.error} wording={DISPATCH_WORDING} />
    </form>
  );
}
