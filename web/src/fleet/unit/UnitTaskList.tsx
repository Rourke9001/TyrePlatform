import { useQuery } from "@tanstack/react-query";

import { fetchUnitTasks } from "../../api/tasks";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { Banner } from "../../ui/Banner";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import { EmptyState } from "../../ui/EmptyState";
import { NominateControl } from "./NominateControl";
import { unitTasksKey } from "./queryKeys";
import { taskDriverLabel, taskStatusLabel } from "./vocabulary";

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
    <Card title="Open inspections" padding="md">
      {tasks.isPending && <p className="unit-note">Loading…</p>}

      {tasks.isError && (
        <Banner
          tone="critical"
          title="The open inspections could not be loaded."
          action={
            <Button variant="primary" onClick={() => void tasks.refetch()}>
              Retry
            </Button>
          }
        />
      )}

      {tasks.isSuccess &&
        (tasks.data.length === 0 ? (
          <EmptyState className="unit-empty" title="No open inspections." />
        ) : (
          // A native table, not DataTable: tasks.spec.ts finds it by its
          // Driver column on the phone projects too, where DataTable draws
          // cards instead of a table.
          <div className="unit-table-wrap">
            <table className="unit-table">
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
                    <th scope="row">
                      {taskDriverLabel(t.responsibleDisplayName, t.responsibleVia)}
                    </th>
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
          </div>
        ))}
    </Card>
  );
}
