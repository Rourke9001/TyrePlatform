import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";

import { getDevTenantId } from "../api/devTenant";
import { refusalMessage } from "../api/refusal";
import {
  fetchRetreadJobs,
  logRetreadReturn,
  type RetreadJob,
  type RetreadReturn,
} from "../api/retreads";
import { useTenantDate } from "../time/tenantTime";
import { useFormMutation } from "./useFormMutation";
import "./fleet.css";

// app.log_retread_return reaches TY012 (no such job), TY014 (an input this
// surface does not accept — a missing casingAccepted, a returnedOn earlier
// than the dispatch) and TY015 (BR-FIT-009's cap, on the accepted branch's
// re-rating), rendered verbatim (NFR-USE-005).
const RETURN_WORDING = {
  speakable: ["TY012", "TY014", "TY015"],
  forbidden: "You do not have permission to log a retread return.",
  fallback: "The return could not be logged. Try again, or call support if it keeps happening.",
};

const INCOMPLETE_RETURN =
  "An outcome, a report reference and a returned-on date are all required before a return can be logged.";

type Outcome = "accepted" | "rejected";

// A per-job return form. Kept out of RetreadQueue's own JSX rather than
// inlined in the map: each row owns its own field state, and a return that
// clears on success must not disturb the row beside it.
//
// newPatternId is not offered here, and is unlikely to be soon: no
// pattern-list read exists yet, and a raw uuid text box is not a usable
// control for a driver or a controller — app.log_retread_return already
// accepts the field, so a follow-up ticket raises the picker rather than
// this slice inventing one.
//
// onSuccess names nothing further: the confirmation this write earns lives
// at RetreadQueue, since a successful return closes the job and this row
// leaves the list on the refetch before anyone could read a line left
// inside it.
function RetreadReturnRow({
  job,
  tenantKey,
  sentOnDisplay,
  onSuccess,
}: {
  job: RetreadJob;
  tenantKey: string;
  sentOnDisplay: string;
  onSuccess?: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome | "">("");
  const [returnedOn, setReturnedOn] = useState("");
  const [reportReference, setReportReference] = useState("");
  const [retreadCost, setRetreadCost] = useState("");
  const [postTreadMm, setPostTreadMm] = useState("");
  const [casingValue, setCasingValue] = useState("");
  // A refusal this row raised itself, distinct from the server's own
  // (rendered below from logReturn.error) — the pattern PositionPanel.tsx
  // uses for its own client-side guard.
  const [refused, setRefused] = useState("");

  const logReturn = useFormMutation<RetreadReturn, void>({
    mutate: (vars) => logRetreadReturn(job.id, vars),
    invalidate: [["retread-jobs"], ["tyres", tenantKey]],
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
    // Number()'d — the database rounds, this does not. Trimmed like every
    // other free-text field on this row; still a string either way.
    if (outcome === "accepted") {
      logReturn.submit({
        returnedOn,
        casingAccepted: true,
        reportReference: reference,
        retreadCost: retreadCost.trim(),
        postTreadMm: postTreadMm.trim(),
        casingValue: casingValue.trim(),
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
                onChange={() => setOutcome("accepted")}
              />
              Accepted
            </label>
            <label>
              <input
                type="radio"
                name={`outcome-${job.id}`}
                value="rejected"
                checked={outcome === "rejected"}
                onChange={() => setOutcome("rejected")}
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

        {refused !== "" && <p role="alert">{refused}</p>}
        {logReturn.error !== null && (
          <p role="alert">{refusalMessage(logReturn.error, RETURN_WORDING)}</p>
        )}
      </td>
    </tr>
  );
}

// D7: the open retread jobs, and the one write this screen owns — logging
// the return app.dispatch_tyre started (retreads.go's own comment: dispatch
// opens the job, this closes it).
export function RetreadQueue() {
  const tenantKey = getDevTenantId() ?? "default";
  const asDate = useTenantDate();
  // The last job this screen closed, held here rather than in the row that
  // closed it: a successful return invalidates ["retread-jobs"], the row's
  // own job leaves the refetched list, and RetreadReturnRow unmounts with
  // it — a line left inside that row would show for one round-trip and
  // vanish (NFR-USE-010).
  const [closedCode, setClosedCode] = useState<string | null>(null);

  const jobs = useQuery({ queryKey: ["retread-jobs"], queryFn: fetchRetreadJobs });

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
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
