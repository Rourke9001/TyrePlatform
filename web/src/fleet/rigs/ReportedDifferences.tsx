import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import {
  applyReportedDifference,
  dismissReportedDifference,
  fetchReportedDifferences,
  type ReportedDifference,
} from "../../api/observations";
import { getDevTenantId } from "../../api/devTenant";
import { refusalMessage } from "../../api/refusal";
import { useCan } from "../../auth/actorContext";
import { useTenantDate } from "../../time/tenantTime";
import { useFormMutation } from "../useFormMutation";
import { observationsKey, rigsKey, vehiclesKey } from "../unit/queryKeys";
import "../fleet.css";

// The codes these writes can actually raise: TY022 is the resolution's own
// refusals, TY017 arrives when a seen unit has since been disposed/coupled
// elsewhere, TY012 is an out-of-view report (falls to the fallback for a
// depot manager).
const WORDING = {
  speakable: ["TY022", "TY017", "TY012"],
  forbidden: "You do not have permission to action a reported difference.",
  fallback: "The report could not be actioned. Refresh and retry.",
};

// The driver's sentence in yard words. The date is the CAPTURE's, not the
// submit's: ADR-0009's outbox can deliver hours later, and the controller
// is being asked about when the coupling was seen.
function sentence(row: ReportedDifference, asDate: (instant: string) => string): string {
  const missing = row.removed.join(", ");
  const verb = row.removed.length === 1 ? "was" : "were";
  return `${row.driver.displayName} reported on ${asDate(row.startedAt)} that ${missing} ${verb} not coupled to ${row.rig.motiveFleetNumber}'s rig.`;
}

function DifferenceCard({ row, tenantKey }: { row: ReportedDifference; tenantKey: string }) {
  const asDate = useTenantDate();
  const canAction = useCan("ManageAssignments");
  const [note, setNote] = useState("");
  const stale = row.stale;

  const invalidate = [observationsKey(tenantKey), rigsKey(tenantKey), vehiclesKey(tenantKey)];
  const apply = useFormMutation({
    mutate: () => applyReportedDifference(row.id, note.trim() === "" ? {} : { note: note.trim() }),
    invalidate,
  });
  const dismiss = useFormMutation({
    mutate: () => dismissReportedDifference(row.id, { note: note.trim() }),
    invalidate,
  });
  const error = apply.error ?? dismiss.error;

  return (
    <li className="note-card">
      <p>{sentence(row, asDate)}</p>
      {canAction && (
        <>
          <label htmlFor={`note-${row.id}`}>Note</label>
          <input
            id={`note-${row.id}`}
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          {stale ? (
            <p>This rig has since ended; dismiss the report.</p>
          ) : (
            <button
              className="btn-primary btn-compact"
              type="button"
              disabled={apply.isPending}
              onClick={() => apply.submit(undefined)}
            >
              Apply
            </button>
          )}
          <button
            className="btn-compact"
            type="button"
            disabled={dismiss.isPending || note.trim() === ""}
            onClick={() => dismiss.submit(undefined)}
          >
            Dismiss
          </button>
        </>
      )}
      {error !== null && error !== undefined && (
        <p role="alert">{refusalMessage(error, WORDING)}</p>
      )}
    </li>
  );
}

// D5: the reports sit above the register they change, because acting on one
// is what the controller came to this screen to do. Nothing renders when
// there are none. An empty state here would be a permanent line of furniture
// on a screen whose own job is the rig list below it.
export function ReportedDifferences() {
  const tenantKey = getDevTenantId() ?? "default";
  const reports = useQuery({
    queryKey: observationsKey(tenantKey),
    queryFn: () => fetchReportedDifferences(),
  });

  if (!reports.isSuccess || reports.data.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="reported-differences-heading">
      <h2 id="reported-differences-heading">Reported differences</h2>
      <ul>
        {reports.data.map((row) => (
          <DifferenceCard key={row.id} row={row} tenantKey={tenantKey} />
        ))}
      </ul>
    </section>
  );
}
