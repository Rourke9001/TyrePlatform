import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { refusalMessage } from "../../api/refusal";
import { fetchUnitTasks, nominate, type UnitTask } from "../../api/tasks";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { useFormMutation } from "../useFormMutation";
import { DriverPicker } from "./DriverPicker";
import { tripBlockersPrefix, unitTasksKey } from "./queryKeys";
import { taskDriverLabel, taskStatusLabel } from "./vocabulary";
import "../fleet.css";

// app.nominate_for_task's own refusals (TY018) and the not-visible read
// (TY012), the only two codes the nomination can reach.
const NOMINATE_WORDING = {
  speakable: ["TY018", "TY012"],
  forbidden: "You do not have permission to nominate a driver.",
  fallback: "The driver could not be nominated. Retry.",
};

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
                      {t.responsibleVia !== "TRIP" && <NominateControl task={t} unitId={unitId} />}
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

function NominateControl({ task, unitId }: { task: UnitTask; unitId: string }) {
  const [userId, setUserId] = useState("");
  const nomination = useFormMutation({
    mutate: (id: string) => nominate(task.id, { userId: id }),
    // A nomination can clear what holds a trip start (U148).
    invalidate: [unitTasksKey(unitId), tripBlockersPrefix()],
    onSuccess: () => setUserId(""),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (userId === "") return;
    nomination.submit(userId);
  }

  return (
    <form onSubmit={submit}>
      <DriverPicker
        id={`nominate-${task.id}`}
        label="Driver"
        value={userId}
        onChange={setUserId}
        placeholder="Choose…"
      />
      <button
        className="btn-primary"
        type="submit"
        disabled={userId === "" || nomination.isPending}
      >
        {nomination.isPending ? "Nominating…" : "Nominate"}
      </button>
      {nomination.error !== null && (
        <p role="alert">{refusalMessage(nomination.error, NOMINATE_WORDING)}</p>
      )}
    </form>
  );
}
