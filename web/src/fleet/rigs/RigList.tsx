import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { endRig, fetchRigs, type Rig } from "../../api/combinations";
import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { TableScroll } from "../../ui/DataTable";
import { useFormMutation } from "../useFormMutation";
import { rigsKey, vehiclesKey } from "../unit/queryKeys";
import "../fleet.css";

// app.end_combination's own refusals (TY017: already ended, or an end before
// the start) and the not-visible read (TY012). The only two codes this
// screen's one write can reach (D4).
const END_WORDING = {
  speakable: ["TY017", "TY012"],
  forbidden: "You do not have permission to end a rig.",
  fallback: "The rig could not be ended. Retry.",
};

// D5's train: motive first, then each trailer in walk order with its
// descriptor in parentheses. Text content is pinned (e2e rigs.spec.ts);
// the quieter weight on towed units is styling only.
function TrainCell({ rig }: { rig: Rig }) {
  const towed = rig.members.filter((m) => m.sequence > 1).sort((a, b) => a.sequence - b.sequence);
  return (
    <td>
      {rig.motiveFleetNumber}
      {towed.map((m) => (
        <span key={m.vehicleId}>
          {" › "}
          <span className="rigs-towed">
            {m.descriptor ? `${m.fleetNumber} (${m.descriptor})` : m.fleetNumber}
          </span>
        </span>
      ))}
    </td>
  );
}

export function RigList() {
  const asDate = useTenantDate();
  const tenantKey = getDevTenantId() ?? "default";
  const canEnd = useCan("ManageAssignments");

  const rigs = useQuery({ queryKey: rigsKey(tenantKey), queryFn: () => fetchRigs() });

  const end = useFormMutation({
    mutate: (rigId: string) => endRig(rigId, {}),
    invalidate: [rigsKey(tenantKey), vehiclesKey(tenantKey)],
  });

  return (
    <>
      {rigs.isPending && <p>Loading…</p>}

      {rigs.isError && (
        <Banner
          tone="critical"
          title={<h2 className="fleet-banner-heading">Rigs didn&apos;t load</h2>}
          action={<Button onClick={() => void rigs.refetch()}>Retry</Button>}
        >
          The server could not be reached. Check your connection, then retry.
        </Banner>
      )}

      {end.isSuccess && end.result && (
        <p role="status">Rig ended for {end.result.motiveFleetNumber}.</p>
      )}
      {end.error !== null && (
        <Banner tone="critical" title={refusalMessage(end.error, END_WORDING)} />
      )}

      {rigs.isSuccess && (
        <>
          <h2 className="fleet-section-title">Open rigs</h2>
          {(() => {
            const open = rigs.data.filter((r) => r.effectiveTo === null);
            return open.length === 0 ? (
              <p className="fleet-note">
                No open rigs. A unit not in a rig is inspected on its own.
              </p>
            ) : (
              <Card padding="none">
                <TableScroll label="Open rigs table">
                  <table className="fleet-table">
                    <thead>
                      <tr>
                        <th scope="col">Motive</th>
                        <th scope="col">Rig</th>
                        <th scope="col">Since</th>
                        {canEnd && <th scope="col">Actions</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {open.map((rig) => (
                        <tr key={rig.id}>
                          <th scope="row" data-mono="true">
                            <Link to={`/fleet/units/${rig.motiveVehicleId}`}>
                              {rig.motiveFleetNumber}
                            </Link>
                          </th>
                          <TrainCell rig={rig} />
                          <td data-nowrap="true">{asDate(rig.effectiveFrom)}</td>
                          {canEnd && (
                            <td>
                              <Button disabled={end.isPending} onClick={() => end.submit(rig.id)}>
                                End rig
                              </Button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              </Card>
            );
          })()}

          <h2 className="fleet-section-title">Ended rigs</h2>
          {(() => {
            const ended = rigs.data.filter((r) => r.effectiveTo !== null);
            return ended.length === 0 ? (
              <p className="fleet-note">No ended rigs yet.</p>
            ) : (
              <Card padding="none">
                <TableScroll label="Ended rigs table">
                  <table className="fleet-table">
                    <thead>
                      <tr>
                        <th scope="col">Motive</th>
                        <th scope="col">Rig</th>
                        <th scope="col">Since</th>
                        <th scope="col">Until</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ended.map((rig) => (
                        <tr key={rig.id}>
                          <th scope="row" data-mono="true">
                            <Link to={`/fleet/units/${rig.motiveVehicleId}`}>
                              {rig.motiveFleetNumber}
                            </Link>
                          </th>
                          <TrainCell rig={rig} />
                          <td data-nowrap="true">{asDate(rig.effectiveFrom)}</td>
                          <td data-nowrap="true">{rig.effectiveTo && asDate(rig.effectiveTo)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableScroll>
              </Card>
            );
          })()}
        </>
      )}
    </>
  );
}
