import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { fetchUnitDrivers, scheduleTask, type NewTask } from "../../api/tasks";
import type { Unit } from "../../api/units";
import { refusalMessage } from "../../api/refusal";
import { useTenantDate } from "../../time/tenantTime";
import { useFormMutation } from "../useFormMutation";
import { unitDriversKey, unitTasksKey } from "./queryKeys";
import "../fleet.css";

// app.create_inspection_task's own refusal (TY018, spec U11) plus the
// not-visible read (TY012) — the only two codes this screen's one write can
// reach.
const SCHEDULE_WORDING = {
  speakable: ["TY018", "TY012"],
  forbidden: "You do not have permission to schedule an inspection.",
  fallback: "The inspection could not be scheduled. Retry.",
};

// spec U2: reads on this screen are ViewFleet's, but this write is
// ManageAssignments' — a narrower capability than the ManageAssets forms
// beside it, so the two must not be conflated at the call site.
export function ScheduleInspectionForm({ unit }: { unit: Unit }) {
  const drivers = useQuery({
    queryKey: unitDriversKey(unit.id),
    queryFn: () => fetchUnitDrivers(unit.id),
  });

  const [assigneeId, setAssigneeId] = useState("");
  const [dueOn, setDueOn] = useState("");
  const tenantDate = useTenantDate();

  const schedule = useFormMutation({
    mutate: (body: NewTask) => scheduleTask(unit.id, body),
    invalidate: [unitTasksKey(unit.id)],
    onSuccess: () => {
      setAssigneeId("");
      setDueOn("");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (assigneeId === "") return;
    const body: NewTask = { assigneeUserId: assigneeId };
    // Same reasoning as RigForm's effectiveOn: an empty date omits dueOn so
    // the server resolves the tenant's today (rule 6).
    if (dueOn.trim() !== "") {
      body.dueOn = dueOn;
    }
    schedule.submit(body);
  }

  return (
    <section className="tyres-receive" aria-labelledby="schedule-inspection-heading">
      <h2 id="schedule-inspection-heading">Schedule an inspection</h2>
      {drivers.isError && (
        <p role="alert">
          The driver list could not be loaded.{" "}
          <button type="button" onClick={() => void drivers.refetch()}>
            Retry
          </button>
        </p>
      )}
      <form onSubmit={submit}>
        {drivers.isSuccess && drivers.data.length > 0 && (
          <div className="tyres-row-form">
            <label htmlFor="taskDriver">Driver</label>
            <select
              id="taskDriver"
              value={assigneeId}
              onChange={(e) => setAssigneeId(e.target.value)}
            >
              <option value="">Choose…</option>
              {drivers.data.map((d) => (
                <option key={d.userId} value={d.userId}>
                  {/* FR-INS-053, spec U4: the motive's driver reaches the
                      trailer through the rig, so the option names the unit
                      the assignment is actually made against whenever that
                      is not this unit itself. */}
                  {d.displayName}
                  {d.viaVehicleId !== unit.id ? ` (via ${d.viaFleetNumber})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}
        {drivers.isSuccess && drivers.data.length === 0 && (
          <p className="tyres-receive-hint">
            No driver is assigned to this unit. Assign one before scheduling an inspection.
          </p>
        )}

        <div className="tyres-row-form">
          <label htmlFor="taskDueOn">Due</label>
          <input
            id="taskDueOn"
            type="date"
            value={dueOn}
            onChange={(e) => setDueOn(e.target.value)}
          />
        </div>
        <p className="tyres-receive-hint">Leave empty for today.</p>

        <button
          className="btn-primary"
          type="submit"
          disabled={assigneeId === "" || schedule.isPending}
        >
          {schedule.isPending ? "Scheduling…" : "Schedule inspection"}
        </button>
      </form>

      {schedule.isSuccess && schedule.result && (
        <p role="status">
          Inspection scheduled for {schedule.result.assignedDisplayName}, due{" "}
          {tenantDate(schedule.result.dueAt)}.
        </p>
      )}
      {schedule.error !== null && (
        <p role="alert">{refusalMessage(schedule.error, SCHEDULE_WORDING)}</p>
      )}
    </section>
  );
}
