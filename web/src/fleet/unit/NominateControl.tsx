import { useState, type FormEvent } from "react";

import { refusalMessage } from "../../api/refusal";
import { nominate } from "../../api/tasks";
import { useFormMutation } from "../useFormMutation";
import { DriverPicker } from "./DriverPicker";
import { unitTasksKey } from "./queryKeys";

// app.nominate_for_task's own refusals (TY018) and the not-visible read
// (TY012), the only two codes a nomination can reach.
const NOMINATE_WORDING = {
  speakable: ["TY018", "TY012"],
  forbidden: "You do not have permission to nominate a driver.",
  fallback: "The driver could not be nominated. Retry.",
};

// A driver for one outstanding task (FR-INS-051 as amended), from the task
// list and from the trip start form's due inspections alike. unitId is the
// task's own unit, whose list it invalidates; a nomination can also clear
// what holds a trip start (U148).
export function NominateControl({
  taskId,
  unitId,
  label = "Driver",
}: {
  taskId: string;
  unitId: string;
  label?: string;
}) {
  const [userId, setUserId] = useState("");
  const nomination = useFormMutation({
    mutate: (id: string) => nominate(taskId, { userId: id }),
    invalidate: [unitTasksKey(unitId)],
    onSuccess: () => setUserId(""),
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    if (userId === "") return;
    nomination.submit(userId);
  }

  return (
    <form className="tyres-row-form" onSubmit={submit}>
      <DriverPicker
        id={`nominate-${taskId}`}
        label={label}
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
