import { useQuery } from "@tanstack/react-query";

import { fetchUnitTasks } from "../../api/tasks";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { NominateControl } from "./NominateControl";
import { unitTasksKey } from "./queryKeys";
import { taskDriverLabel, taskStatusLabel } from "./vocabulary";
import "../fleet.css";

// spec U2: every ViewFleet reader sees this list; the nominate control is
// ManageAssignments' (spec, Trip screens), offered on a task no trip holds,
// since one a trip covers already goes to its driver.
export function UnitTaskList({ unitId }: { unitId: string }) {
  const asDate = useTenantDate();
  const canAssign = useCan("ManageAssignments");
  const tasks = useQuery({
    queryKey: unitTasksKey(unitId),
    queryFn: () => fetchUnitTasks(unitId),
  });

  return (
    <>
      <h2>Open inspections</h2>
      {tasks.isPending && <p className="note-card">Loading…</p>}

      {tasks.isError && (
        <div className="note-card" role="alert">
          <p>The open inspections could not be loaded.</p>
          <button className="btn-primary" type="button" onClick={() => void tasks.refetch()}>
            Retry
          </button>
        </div>
      )}

      {tasks.isSuccess &&
        (tasks.data.length === 0 ? (
          <p className="note-card">No open inspections.</p>
        ) : (
          <table className="fitments-table">
            <thead>
              <tr>
                <th scope="col">Driver</th>
                <th scope="col">Due</th>
                <th scope="col">Status</th>
                {canAssign && <th scope="col">Nominate</th>}
              </tr>
            </thead>
            <tbody>
              {tasks.data.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{taskDriverLabel(t.responsibleDisplayName, t.responsibleVia)}</th>
                  <td>{asDate(t.dueAt)}</td>
                  <td>{taskStatusLabel(t.escalated, t.overdue)}</td>
                  {canAssign && (
                    <td>
                      {t.responsibleVia !== "TRIP" && (
                        <NominateControl taskId={t.id} unitId={unitId} />
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}
