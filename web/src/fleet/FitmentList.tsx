import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { getDevTenantId } from "../api/devTenant";
import { fetchOpenFitments, type FleetFitment } from "../api/units";
import { useTenantDate } from "../time/tenantTime";
import { openFitmentsKey } from "./unit/queryKeys";
import "./fleet.css";

// D7/ViewFleet: every position the fleet currently has occupied, in one
// list. daysFitted comes from the server's own tenant-time arithmetic (rule
// 6) — this renders the number, never derives one from a browser clock.
export function FitmentList() {
  const asDate = useTenantDate();
  const tenantKey = getDevTenantId() ?? "default";

  const fitments = useQuery({ queryKey: openFitmentsKey(tenantKey), queryFn: fetchOpenFitments });

  return (
    <section aria-labelledby="fitments-heading" className="fitments">
      <h1 className="page-title" id="fitments-heading">
        Fitments
      </h1>

      {fitments.isPending && <p>Loading…</p>}

      {fitments.isError && (
        <div className="note-card" role="alert">
          <h2>Fitments didn&apos;t load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <button className="btn-primary" type="button" onClick={() => void fitments.refetch()}>
            Retry
          </button>
        </div>
      )}

      {fitments.isSuccess && fitments.data.length === 0 && (
        <p className="note-card">No positions are currently fitted.</p>
      )}

      {fitments.isSuccess && fitments.data.length > 0 && (
        <table className="fitments-table">
          <thead>
            <tr>
              <th scope="col">Unit</th>
              <th scope="col">Position</th>
              <th scope="col">Tyre</th>
              <th scope="col">Fitted on</th>
              <th scope="col">Days fitted</th>
            </tr>
          </thead>
          <tbody>
            {fitments.data.map((f: FleetFitment) => (
              <tr key={f.fitmentId}>
                <th scope="row">
                  <Link to={`/fleet/units/${f.vehicleId}`}>{f.fleetNumber}</Link>
                </th>
                <td>{f.positionCode}</td>
                <td>{f.displayCode}</td>
                <td>{asDate(f.fittedAt)}</td>
                <td>{f.daysFitted}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
