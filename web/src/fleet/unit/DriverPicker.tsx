import { useQuery } from "@tanstack/react-query";

import { getDevTenantId } from "../../api/devTenant";
import { fetchDrivers } from "../../api/trips";
import { driversKey } from "./queryKeys";

// The one driver picker, for a trip start and a nomination alike: active
// users who can capture, each named with the truck of their open trip, so a
// controller sees what a start would end (spec, Trip screens). The list is
// the tenant's, not the depot's (spec, Depot scope).
export function DriverPicker({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (userId: string) => void;
  placeholder: string;
}) {
  const tenantKey = getDevTenantId() ?? "default";
  const drivers = useQuery({ queryKey: driversKey(tenantKey), queryFn: fetchDrivers });

  return (
    <>
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {(drivers.data ?? []).map((d) => (
          <option key={d.userId} value={d.userId}>
            {d.displayName}
            {d.onTrip ? `, on the trip with ${d.onTrip.fleetNumber}` : ""}
          </option>
        ))}
      </select>
      {drivers.isError && (
        <>
          <p role="alert">The driver list could not be loaded.</p>
          {/* A sibling of the alert, not inside it, so assistive tech that
              reads the region and stops still reaches it (AddDriver.tsx). */}
          <button type="button" onClick={() => void drivers.refetch()}>
            Retry
          </button>
        </>
      )}
    </>
  );
}
