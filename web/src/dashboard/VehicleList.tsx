import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchVehicles } from "../api/vehicles";
import { getDevTenantId } from "../api/devTenant";
import { AxleSchematic } from "./AxleSchematic";
import { searchVehicles } from "./vehicleSearch";

export function VehicleList() {
  const [query, setQuery] = useState("");
  const tenantKey = getDevTenantId() ?? "default";
  const vehicles = useQuery({
    queryKey: ["vehicles", tenantKey],
    queryFn: fetchVehicles,
  });

  return (
    <section aria-labelledby="vehicles-heading">
      <div className="vehicles-bar">
        <h1 id="vehicles-heading">Units</h1>
        <input
          type="search"
          className="vehicles-search"
          placeholder="Search fleet number or registration"
          aria-label="Search vehicles by fleet number or registration"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {vehicles.isPending && (
        <ul className="vehicle-rows" aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="vehicle-row vehicle-row-skeleton">
              <span className="skeleton-block" />
            </li>
          ))}
        </ul>
      )}

      {vehicles.isError && (
        <div className="vehicles-note" role="alert">
          <h2>Units didn't load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <button type="button" onClick={() => void vehicles.refetch()}>
            Retry
          </button>
        </div>
      )}

      {vehicles.isSuccess && vehicles.data.length === 0 && (
        <div className="vehicles-note">
          <h2>No vehicles yet</h2>
          <p>
            Your fleet appears here once vehicles are registered. Vehicle registration opens in an
            upcoming release.
          </p>
        </div>
      )}

      {vehicles.isSuccess && vehicles.data.length > 0 && (
        <VehicleRows
          query={query}
          rows={searchVehicles(vehicles.data, query)}
          total={vehicles.data.length}
        />
      )}
    </section>
  );
}

function VehicleRows({
  rows,
  total,
  query,
}: {
  rows: ReturnType<typeof searchVehicles>;
  total: number;
  query: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="vehicles-note">
        <h2>No matches</h2>
        <p>
          No fleet number or registration contains “{query.trim()}”. Clear the search to see all{" "}
          {total} vehicles.
        </p>
      </div>
    );
  }
  return (
    <>
      <p className="vehicles-count">
        {rows.length === total ? `${total} vehicles` : `${rows.length} of ${total} vehicles`}
      </p>
      <ul className="vehicle-rows">
        {rows.map((v) => (
          <li key={v.id} className="vehicle-row">
            <AxleSchematic />
            <span className="vehicle-fleet">{v.fleetNumber}</span>
            <span className="vehicle-reg">{v.registration ?? "No registration"}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
