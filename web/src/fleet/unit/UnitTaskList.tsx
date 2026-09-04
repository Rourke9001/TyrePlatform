import { useQuery } from "@tanstack/react-query";

import { fetchUnitTasks } from "../../api/tasks";
import { useTenantDate } from "../../time/tenantTime";
import { unitTasksKey } from "./queryKeys";
import "../fleet.css";

// spec U2: every ViewFleet reader sees this, unlike the schedule form beside
// it (ManageAssignments), so it carries no capability gate of its own.
export function UnitTaskList({ unitId }: { unitId: string }) {
  const asDate = useTenantDate();
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
              </tr>
            </thead>
            <tbody>
              {tasks.data.map((t) => (
                <tr key={t.id}>
                  <th scope="row">{t.assignedDisplayName ?? "Unassigned"}</th>
                  <td>{asDate(t.dueAt)}</td>
                  {/* NFR-USE-009: overdue is a word, never colour alone. */}
                  <td>{t.overdue ? "Overdue" : t.state === "ESCALATED" ? "Escalated" : "Open"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
    </>
  );
}
