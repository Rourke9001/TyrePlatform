import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { fetchVehicles } from "../api/vehicles";
import { getDevTenantId } from "../api/devTenant";
import { useCan } from "../auth/actorContext";
import { vehiclesKey } from "../fleet/unit/queryKeys";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { ListRow } from "../ui/ListRow";
import { SearchIcon } from "../ui/icons/Search";
import { TruckIcon } from "../ui/icons/Truck";
import { PageHeader } from "../ui/PageHeader";
import { SearchInput } from "../ui/SearchInput";
import { searchVehicles } from "./vehicleSearch";
import "./dashboard.css";

export function VehicleList() {
  const [query, setQuery] = useState("");
  const canManage = useCan("ManageAssets");
  const tenantKey = getDevTenantId() ?? "default";
  const vehicles = useQuery({
    queryKey: vehiclesKey(tenantKey),
    queryFn: fetchVehicles,
  });

  return (
    <section className="unit-list" aria-labelledby="vehicles-heading">
      <PageHeader
        title={<span id="vehicles-heading">Units</span>}
        actions={
          <SearchInput
            className="unit-search"
            label="Search units by fleet number or registration"
            placeholder="Search fleet number or registration"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        }
      />

      {vehicles.isPending && (
        <Card padding="none">
          <ul className="tr-list vehicle-rows" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="unit-row-skeleton">
                <span />
              </li>
            ))}
          </ul>
        </Card>
      )}

      {vehicles.isError && (
        <Banner
          tone="warning"
          title={<h2 className="unit-list__failure">Units didn't load</h2>}
          action={
            <Button variant="primary" onClick={() => void vehicles.refetch()}>
              Retry
            </Button>
          }
        >
          The server could not be reached. Check your connection, then retry.
        </Banner>
      )}

      {vehicles.isSuccess && vehicles.data.length === 0 && (
        <EmptyState icon={TruckIcon} title="No units yet" headingLevel={2}>
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
        </EmptyState>
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
      <EmptyState icon={SearchIcon} title="No matches" headingLevel={2}>
        <p>
          No fleet number or registration contains "{query.trim()}". Clear the search to see all{" "}
          {total} units.
        </p>
      </EmptyState>
    );
  }
  return (
    <>
      <p className="vehicles-count">
        {rows.length === total ? `${total} units` : `${rows.length} of ${total} units`}
      </p>
      <Card padding="none">
        <ul className="tr-list vehicle-rows">
          {rows.map((v) => (
            <li key={v.id}>
              {/* The whole row is the link, registration and all: D7 makes
                  the list the way into a unit, and a row-wide link is what a
                  finger hits. */}
              <ListRow
                to={`/fleet/units/${v.id}`}
                title={v.fleetNumber}
                meta={v.registration ?? "No registration"}
              />
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
