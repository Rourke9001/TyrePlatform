import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";

import { endRig, fetchRigs, type Rig } from "../../api/combinations";
import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { useFormMutation } from "../useFormMutation";
import { rigsKey, vehiclesKey } from "../unit/queryKeys";
import "../fleet.css";

// app.end_combination's own refusals (TY017: already ended, or an end before
// the start) and the not-visible read (TY012) — the only two codes this
// screen's one write can reach (D4).
const END_WORDING = {
  speakable: ["TY017", "TY012"],
  forbidden: "You do not have permission to end a rig.",
  fallback: "The rig could not be ended. Retry.",
};

// D5's train: the motive first, then each trailer in walk order, its
// descriptor in parentheses immediately after its fleet number. The text
// content is pinned (task brief / e2e rigs.spec.ts) — the quieter weight on
// the towed units is styling only, never a change to the text itself.
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
        <div className="note-card" role="alert">
          <h2>Rigs didn&apos;t load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <button className="btn-primary" type="button" onClick={() => void rigs.refetch()}>
            Retry
          </button>
        </div>
      )}

      {/* useFormMutation keeps isSuccess for the life of the list, so a guard
          that stops a second click would otherwise leave this line standing
          beside a fresh alert from the next attempt. */}
      {end.isSuccess && end.error === null && end.result && (
        <p role="status">Rig ended for {end.result.motiveFleetNumber}.</p>
      )}
      {end.error !== null && <p role="alert">{refusalMessage(end.error, END_WORDING)}</p>}

      {rigs.isSuccess && (
        <>
          <h2>Open rigs</h2>
          {(() => {
            const open = rigs.data.filter((r) => r.effectiveTo === null);
            return open.length === 0 ? (
              <p className="note-card">
                No open rigs. A unit not in a rig is inspected on its own.
              </p>
            ) : (
              <table className="fitments-table">
                <thead>
                  <tr>
                    <th scope="col">Motive</th>
                    <th scope="col">Rig</th>
                    <th scope="col">Since</th>
                    {canEnd && <th scope="col" />}
                  </tr>
                </thead>
                <tbody>
                  {open.map((rig) => (
                    <tr key={rig.id}>
                      <th scope="row">
                        <Link to={`/fleet/units/${rig.motiveVehicleId}`}>
                          {rig.motiveFleetNumber}
                        </Link>
                      </th>
                      <TrainCell rig={rig} />
                      <td>{asDate(rig.effectiveFrom)}</td>
                      {canEnd && (
                        <td>
                          <button
                            className="btn-primary"
                            type="button"
                            disabled={end.isPending}
                            onClick={() => end.submit(rig.id)}
                          >
                            End rig
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}

          <h2>Ended rigs</h2>
          {(() => {
            const ended = rigs.data.filter((r) => r.effectiveTo !== null);
            return ended.length === 0 ? (
              <p className="note-card">No ended rigs yet.</p>
            ) : (
              <table className="fitments-table">
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
                      <th scope="row">
                        <Link to={`/fleet/units/${rig.motiveVehicleId}`}>
                          {rig.motiveFleetNumber}
                        </Link>
                      </th>
                      <TrainCell rig={rig} />
                      <td>{asDate(rig.effectiveFrom)}</td>
                      <td>{rig.effectiveTo && asDate(rig.effectiveTo)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })()}
        </>
      )}
    </>
  );
}
