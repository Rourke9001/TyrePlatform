import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { fetchVehicles } from "../api/vehicles";
import { getDevTenantId } from "../api/devTenant";
import { useCan } from "../auth/actorContext";
import { vehiclesKey } from "../fleet/unit/queryKeys";
import { searchVehicles } from "./vehicleSearch";

export function VehicleList() {
  const [query, setQuery] = useState("");
  const canManage = useCan("ManageAssets");
  const tenantKey = getDevTenantId() ?? "default";
  const vehicles = useQuery({
    queryKey: vehiclesKey(tenantKey),
    queryFn: fetchVehicles,
  });

  return (
    <section aria-labelledby="vehicles-heading">
      <div className="vehicles-bar">
        <h1 className="page-title" id="vehicles-heading">
          Units
        </h1>
        <input
          type="search"
          className="vehicles-search"
          placeholder="Search fleet number or registration"
          aria-label="Search units by fleet number or registration"
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
        <div className="note-card" role="alert">
          <h2>Units didn't load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <button className="btn-primary" type="button" onClick={() => void vehicles.refetch()}>
            Retry
          </button>
        </div>
      )}

      {vehicles.isSuccess && vehicles.data.length === 0 && (
        <div className="note-card">
          <h2>No units yet</h2>
          {/* The screen behind the link is AdminRoute'd on ManageAssets, so
              offering it to a reader who does not hold the capability sends
              them to a refusal (ADR-0013 decision 4). */}
          {canManage ? (
            <p>
              Add one from <Link to="/admin/units/new">Add a unit</Link>.
            </p>
          ) : (
            <p>Ask someone who manages assets to add the first one.</p>
          )}
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
      <div className="note-card">
        <h2>No matches</h2>
        <p>
          No fleet number or registration contains “{query.trim()}”. Clear the search to see all{" "}
          {total} units.
        </p>
      </div>
    );
  }
  return (
    <>
      <p className="vehicles-count">
        {rows.length === total ? `${total} units` : `${rows.length} of ${total} units`}
      </p>
      <ul className="vehicle-rows">
        {rows.map((v) => (
          <li key={v.id}>
            {/* The whole row is the target, not a word inside it: D7 makes the
                list the way into a unit, and a link the width of the row is
                what a finger hits. */}
            <Link className="vehicle-row" to={`/fleet/units/${v.id}`}>
              <span className="vehicle-fleet">{v.fleetNumber}</span>
              <span className="vehicle-reg">{v.registration ?? "No registration"}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
