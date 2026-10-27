import { useQuery } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";

import { scheduleTask, type NewTask } from "../../api/tasks";
import { fetchUnitTrip } from "../../api/trips";
import type { Unit } from "../../api/units";
import { refusalMessage } from "../../api/refusal";
import { useTenantDate } from "../../time/tenantTime";
import { Card } from "../../ui/Card";
import { useFormMutation } from "../useFormMutation";
import { DriverPicker } from "./DriverPicker";
import { tripBlockersPrefix, unitTasksKey, unitTripKey } from "./queryKeys";

// app.create_inspection_task's and app.nominate_for_task's own refusal
// (TY018, spec U11) plus the not-visible read (TY012). The only two codes
// this screen's one write can reach.
const SCHEDULE_WORDING = {
  speakable: ["TY018", "TY012"],
  forbidden: "You do not have permission to schedule an inspection.",
  fallback: "The inspection could not be scheduled. Retry.",
};

// spec U2: reads on this screen are ViewFleet's, but this write is
// ManageAssignments', a narrower capability than the ManageAssets forms
// beside it, so the two must not be conflated at the call site. On a unit
// a trip covers the inspection goes to the trip's driver, so the form says
// so and offers no picker; elsewhere a driver may be nominated, or nobody,
// and then the task reads escalated (FR-INS-051 as amended).
export function ScheduleInspectionForm({ unit }: { unit: Unit }) {
  const trip = useQuery({
    queryKey: unitTripKey(unit.id),
    queryFn: () => fetchUnitTrip(unit.id),
  });

  const [nomineeId, setNomineeId] = useState("");
  const [dueOn, setDueOn] = useState("");
  const tenantDate = useTenantDate();
  const covered = trip.data?.trip ?? null;

  const schedule = useFormMutation({
    mutate: (body: NewTask) => scheduleTask(unit.id, body),
    // A new task can hold a trip start (U148).
    invalidate: [unitTasksKey(unit.id), tripBlockersPrefix()],
    onSuccess: () => {
      setNomineeId("");
      setDueOn("");
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: NewTask = {};
    if (covered === null && nomineeId !== "") {
      body.nomineeUserId = nomineeId;
    }
    // Same reasoning as RigForm's effectiveOn: an empty date omits dueOn so
    // the server resolves the tenant's today (rule 6).
    if (dueOn.trim() !== "") {
      body.dueOn = dueOn;
    }
    schedule.submit(body);
  }

  return (
    <Card className="unit-form-card" title="Schedule an inspection" padding="md">
      {trip.isError && (
        <>
          <p role="alert">Who holds this unit could not be loaded.</p>
          <button type="button" onClick={() => void trip.refetch()}>
            Retry
          </button>
        </>
      )}
      <form onSubmit={submit}>
        {covered !== null && (
          <p className="tyres-receive-hint">
            This inspection goes to {covered.driver.displayName}, on the trip with{" "}
            {covered.motive.fleetNumber}.
          </p>
        )}
        {trip.isSuccess && covered === null && (
          <div className="tyres-row-form">
            <DriverPicker
              id="taskDriver"
              label="Driver"
              value={nomineeId}
              onChange={setNomineeId}
              placeholder="Nobody yet"
            />
          </div>
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

        <button className="btn-primary" type="submit" disabled={schedule.isPending}>
          {schedule.isPending ? "Scheduling…" : "Schedule inspection"}
        </button>
      </form>

      {schedule.isSuccess &&
        schedule.result &&
        (schedule.result.responsibleDisplayName !== null ? (
          <p role="status">
            Inspection scheduled for {schedule.result.responsibleDisplayName}, due{" "}
            {tenantDate(schedule.result.dueAt)}.
          </p>
        ) : (
          <p role="status">
            Inspection scheduled, due {tenantDate(schedule.result.dueAt)}. No driver holds it yet.
          </p>
        ))}
      {schedule.error !== null && (
        <p role="alert">{refusalMessage(schedule.error, SCHEDULE_WORDING)}</p>
      )}
    </Card>
  );
}
