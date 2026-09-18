import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";

import { getDevTenantId } from "../api/devTenant";
import {
  fetchRetreadJobs,
  logRetreadReturn,
  type RetreadJob,
  type RetreadReturn,
} from "../api/retreads";
import { useTenantDate } from "../time/tenantTime";
import { RefusalAlert } from "./RefusalAlert";
import { retreadJobsKey, tyresKey } from "./unit/queryKeys";
import { useFormMutation } from "./useFormMutation";
import "./fleet.css";

// app.log_retread_return reaches TY012 (no such job), TY014 (a rejected
// input) and TY015 (BR-FIT-009's cap), rendered verbatim (NFR-USE-005).
const RETURN_WORDING = {
  speakable: ["TY012", "TY014", "TY015"],
  forbidden: "You do not have permission to log a retread return.",
  fallback: "The return could not be logged. Try again, or call support if it keeps happening.",
};

const INCOMPLETE_RETURN =
  "An outcome, a report reference and a returned-on date are all required before a return can be logged.";

// An absent optional is an omitted key, never "": the numeric cast rejects
// an empty/all-space string as 22P02, a code this screen cannot speak.
// required stops a genuinely empty submit; whitespace still satisfies it,
// which this closes.
function omitIfBlank(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

type Outcome = "accepted" | "rejected";

// A per-job return form, kept out of the map: each row owns its own field
// state, and a cleared-on-success form must not disturb the row beside it.
// newPatternId is not offered: no pattern-list read exists yet, so a raw
// uuid box would not be usable.
function RetreadReturnRow({
  job,
  tenantKey,
  sentOnDisplay,
  onSuccess,
  onStart,
}: {
  job: RetreadJob;
  tenantKey: string;
  sentOnDisplay: string;
  onSuccess?: () => void;
  onStart?: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome | "">("");
  const [returnedOn, setReturnedOn] = useState("");
  const [reportReference, setReportReference] = useState("");
  const [retreadCost, setRetreadCost] = useState("");
  const [postTreadMm, setPostTreadMm] = useState("");
  const [casingValue, setCasingValue] = useState("");
  // A refusal this row raised itself, distinct from the server's own
  // (rendered below from logReturn.error). This is the pattern
  // PositionPanel.tsx uses for its own client-side guard.
  const [refused, setRefused] = useState("");

  const logReturn = useFormMutation<RetreadReturn, void>({
    mutate: (vars) => logRetreadReturn(job.id, vars),
    invalidate: [retreadJobsKey(tenantKey), tyresKey(tenantKey)],
    onSuccess: () => {
      setOutcome("");
      setReturnedOn("");
      setReportReference("");
      setRetreadCost("");
      setPostTreadMm("");
      setCasingValue("");
      onSuccess?.();
    },
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const reference = reportReference.trim();
    if (outcome === "" || returnedOn === "" || reference === "") {
      setRefused(INCOMPLETE_RETURN);
      return;
    }
    setRefused("");

    // D3: money stays a string all the way to the wire (rule 2), never
    // Number()'d. The database rounds, this does not. Trimmed like every
    // other free-text field on this row; still a string either way.
    if (outcome === "accepted") {
      logReturn.submit({
        returnedOn,
        casingAccepted: true,
        reportReference: reference,
        retreadCost: omitIfBlank(retreadCost),
        postTreadMm: omitIfBlank(postTreadMm),
        casingValue: omitIfBlank(casingValue),
      });
    } else {
      logReturn.submit({
        returnedOn,
        casingAccepted: false,
        reportReference: reference,
      });
    }
  }

  return (
    <tr>
      <th scope="row">{job.displayCode}</th>
      <td>{job.depotName}</td>
      <td>{sentOnDisplay}</td>
      <td>{job.daysOut}</td>
      <td>
        <form onSubmit={submit} className="tyres-row-form">
          <div role="radiogroup" aria-label="Outcome">
            <label>
              <input
                type="radio"
                name={`outcome-${job.id}`}
                value="accepted"
                checked={outcome === "accepted"}
                onChange={() => {
                  setOutcome("accepted");
                  onStart?.();
                }}
              />
              Accepted
            </label>
            <label>
              <input
                type="radio"
                name={`outcome-${job.id}`}
                value="rejected"
                checked={outcome === "rejected"}
                onChange={() => {
                  setOutcome("rejected");
                  onStart?.();
                }}
              />
              Rejected
            </label>
          </div>

          <input
            aria-label={`Report reference for ${job.displayCode}`}
            value={reportReference}
            onChange={(e) => setReportReference(e.target.value)}
            required
          />

          <input
            aria-label={`Returned on for ${job.displayCode}`}
            type="date"
            value={returnedOn}
            onChange={(e) => setReturnedOn(e.target.value)}
            required
          />

          {outcome === "accepted" && (
            <>
              <input
                aria-label={`Retread cost for ${job.displayCode}`}
                inputMode="decimal"
                value={retreadCost}
                onChange={(e) => setRetreadCost(e.target.value)}
                required
              />
              <input
                aria-label={`Post-tread for ${job.displayCode}`}
                inputMode="decimal"
                value={postTreadMm}
                onChange={(e) => setPostTreadMm(e.target.value)}
                required
              />
              <input
                aria-label={`Casing value for ${job.displayCode}`}
                inputMode="decimal"
                value={casingValue}
                onChange={(e) => setCasingValue(e.target.value)}
                required
              />
            </>
          )}

          <button
            className="btn-primary btn-compact"
            type="submit"
            disabled={outcome === "" || logReturn.isPending}
          >
            {logReturn.isPending ? "Logging…" : "Log return"}
          </button>
        </form>

        <RefusalAlert message={refused} />
        <RefusalAlert error={logReturn.error} wording={RETURN_WORDING} />
      </td>
    </tr>
  );
}

// D7: the open retread jobs, and the one write this screen owns: logging
// the return app.dispatch_tyre started (retreads.go's own comment: dispatch
// opens the job, this closes it).
export function RetreadQueue() {
  const tenantKey = getDevTenantId() ?? "default";
  const asDate = useTenantDate();
  // The last job this screen closed, held at screen level: RetreadReturnRow
  // unmounts on its own success, so a confirmation left in the row would
  // vanish on the very refetch that should show it (NFR-USE-010).
  const [closedCode, setClosedCode] = useState<string | null>(null);

  const jobs = useQuery({ queryKey: retreadJobsKey(tenantKey), queryFn: fetchRetreadJobs });

  return (
    <section aria-labelledby="retreads-heading" className="retreads">
      <div className="tyres-heading-row">
        <h1 className="page-title" id="retreads-heading">
          Retreads
        </h1>
        <Link to="/fleet/tyres">Back to register</Link>
      </div>

      {closedCode !== null && <p role="status">{`The return for ${closedCode} was logged.`}</p>}

      {jobs.isPending && <p>Loading…</p>}

      {jobs.isError && (
        <div className="note-card" role="alert">
          <h2>Retreads didn&apos;t load</h2>
          <p>The server could not be reached. Check your connection, then retry.</p>
          <button className="btn-primary" type="button" onClick={() => void jobs.refetch()}>
            Retry
          </button>
        </div>
      )}

      {jobs.isSuccess && jobs.data.length === 0 && (
        <p className="note-card">No casings are out for retread.</p>
      )}

      {jobs.isSuccess && jobs.data.length > 0 && (
        <table className="retreads-table">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Depot</th>
              <th scope="col">Sent on</th>
              <th scope="col">Days out</th>
              <th scope="col">Return</th>
            </tr>
          </thead>
          <tbody>
            {jobs.data.map((job: RetreadJob) => (
              <RetreadReturnRow
                key={job.id}
                job={job}
                tenantKey={tenantKey}
                sentOnDisplay={asDate(job.sentAt)}
                onSuccess={() => setClosedCode(job.displayCode)}
                onStart={() => setClosedCode(null)}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
