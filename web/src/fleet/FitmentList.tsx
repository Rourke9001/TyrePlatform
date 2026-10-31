import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { getDevTenantId } from "../api/devTenant";
import { fetchOpenFitments, type FleetFitment } from "../api/units";
import { useTenantDate } from "../time/tenantTime";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { PageHeader } from "../ui/PageHeader";
import { TableScroll } from "../ui/DataTable";
import { openFitmentsKey } from "./unit/queryKeys";
import "./fleet.css";

// D7/ViewFleet: every position the fleet currently has occupied, in one
// list. daysFitted comes from the server's own tenant-time arithmetic (rule
// 6). This renders the number, never derives one from a browser clock.
export function FitmentList() {
  const asDate = useTenantDate();
  const tenantKey = getDevTenantId() ?? "default";

  const fitments = useQuery({ queryKey: openFitmentsKey(tenantKey), queryFn: fetchOpenFitments });

  return (
    <section aria-labelledby="fitments-heading" className="fleet-page tr-stack">
      {/* Heading id: see PageHeader's title prop. */}
      <PageHeader title={<span id="fitments-heading">Fitments</span>} />

      {fitments.isPending && <p>Loading…</p>}

      {fitments.isError && (
        <Banner
          tone="critical"
          title={<h2 className="fleet-banner-heading">Fitments didn&apos;t load</h2>}
          action={<Button onClick={() => void fitments.refetch()}>Retry</Button>}
        >
          The server could not be reached. Check your connection, then retry.
        </Banner>
      )}

      {fitments.isSuccess && fitments.data.length === 0 && (
        <p className="fleet-note">No positions are currently fitted.</p>
      )}

      {fitments.isSuccess && fitments.data.length > 0 && (
        <Card padding="none">
          <TableScroll label="Fitments table">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th scope="col">Unit</th>
                  <th scope="col">Position</th>
                  <th scope="col">Tyre</th>
                  <th scope="col">Fitted on</th>
                  <th scope="col" data-align="right">
                    Days fitted
                  </th>
                </tr>
              </thead>
              <tbody>
                {fitments.data.map((f: FleetFitment) => (
                  <tr key={f.fitmentId}>
                    <th scope="row" data-mono="true">
                      <Link to={`/fleet/units/${f.vehicleId}`}>{f.fleetNumber}</Link>
                    </th>
                    <td data-mono="true">{f.positionCode}</td>
                    <td data-mono="true">{f.displayCode}</td>
                    <td data-nowrap="true">{asDate(f.fittedAt)}</td>
                    <td data-align="right" data-mono="true">
                      {f.daysFitted}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      )}
    </section>
  );
}
