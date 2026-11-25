import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";

import { fetchTyreCatalogue, type TyrePattern } from "../api/catalogue";
import { getDevTenantId } from "../api/devTenant";
import {
  fetchRetreadJobs,
  logRetreadReturn,
  type RetreadJob,
  type RetreadReturn,
} from "../api/retreads";
import { useTenantDate } from "../time/tenantTime";
import { Banner } from "../ui/Banner";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/PageHeader";
import { Select } from "../ui/Select";
import { TextInput } from "../ui/TextInput";
import { TableScroll } from "../ui/DataTable";
import { RefusalAlert } from "./RefusalAlert";
import { byNaturalCode } from "./unit/naturalOrder";
import { retreadJobsKey, tyreCatalogueKey, tyresKey } from "./unit/queryKeys";
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

const PATTERN_NEEDED = "Choose the retread pattern the casing came back on.";

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
// B23, U225 (TYRE-102): an accepted casing comes back on an active retread
// pattern, the one it went out on pre-selected while it is still one, and
// app.log_retread_return refuses any other (000062). patterns is null until
// the catalogue has loaded.
function RetreadReturnRow({
  job,
  tenantKey,
  sentOnDisplay,
  patterns,
  onSuccess,
  onStart,
}: {
  job: RetreadJob;
  tenantKey: string;
  sentOnDisplay: string;
  patterns: TyrePattern[] | null;
  onSuccess?: () => void;
  onStart?: () => void;
}) {
  const [outcome, setOutcome] = useState<Outcome | "">("");
  // null until the user picks, so the pre-selection stays derived and holds
  // when the catalogue answers after the jobs.
  const [patternChoice, setPatternChoice] = useState<string | null>(null);
  const hintId = useId();
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
      setPatternChoice(null);
      setReturnedOn("");
      setReportReference("");
      setRetreadCost("");
      setPostTreadMm("");
      setCasingValue("");
      onSuccess?.();
    },
  });

  const kept = patterns?.some((p) => p.id === job.patternId) === true ? job.patternId : null;
  const patternId = patternChoice ?? kept ?? "";
  const noRetreadPattern = patterns !== null && patterns.length === 0;
  const patternBlocked = outcome === "accepted" && (patterns === null || noRetreadPattern);
  const wentOutOn = kept === null ? job.patternName : null;

  function submit(e: FormEvent) {
    e.preventDefault();
    const reference = reportReference.trim();
    if (outcome === "" || returnedOn === "" || reference === "") {
      setRefused(INCOMPLETE_RETURN);
      return;
    }
    if (patternBlocked) return;
    if (outcome === "accepted" && patternId === "") {
      setRefused(PATTERN_NEEDED);
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
        // Sent only when it differs: none sent keeps the casing's own.
        ...(patternId === job.patternId ? {} : { newPatternId: patternId }),
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
      <th scope="row" data-mono="true">
        {job.displayCode}
      </th>
      <td>{job.depotName}</td>
      <td data-nowrap="true">{sentOnDisplay}</td>
      <td data-align="right" data-mono="true">
        {job.daysOut}
      </td>
      <td>
        <form onSubmit={submit} className="fleet-row-form">
          <div role="radiogroup" aria-label="Outcome" className="fleet-choices">
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

          {/* NFR-USE-007: each control sits in a Field, so the name a
              screen reader speaks is the label on screen. */}
          <Field label={`Report reference for ${job.displayCode}`}>
            <TextInput
              id={`retread-report-${job.id}`}
              value={reportReference}
              onChange={(e) => setReportReference(e.target.value)}
              required
            />
          </Field>

          <Field label={`Returned on for ${job.displayCode}`}>
            <TextInput
              id={`retread-returned-${job.id}`}
              type="date"
              value={returnedOn}
              onChange={(e) => setReturnedOn(e.target.value)}
              required
            />
          </Field>

          {outcome === "accepted" && (
            <>
              <Field label={`Retread cost for ${job.displayCode}`}>
                <TextInput
                  id={`retread-cost-${job.id}`}
                  mono
                  inputMode="decimal"
                  value={retreadCost}
                  onChange={(e) => setRetreadCost(e.target.value)}
                  required
                />
              </Field>
              <Field label={`Post-tread for ${job.displayCode}`}>
                <TextInput
                  id={`retread-tread-${job.id}`}
                  mono
                  inputMode="decimal"
                  value={postTreadMm}
                  onChange={(e) => setPostTreadMm(e.target.value)}
                  required
                />
              </Field>
              <Field label={`Casing value for ${job.displayCode}`}>
                <TextInput
                  id={`retread-casing-${job.id}`}
                  mono
                  inputMode="decimal"
                  value={casingValue}
                  onChange={(e) => setCasingValue(e.target.value)}
                  required
                />
              </Field>
              {noRetreadPattern && (
                <p className="fleet-hint">
                  This fleet has no retread pattern yet. Ask an administrator to add the
                  retreader&apos;s patterns, then log the return.
                </p>
              )}
              {patterns !== null && !noRetreadPattern && (
                <>
                  <Field label={`Pattern for ${job.displayCode}`}>
                    <Select
                      id={`retread-pattern-${job.id}`}
                      value={patternId}
                      onChange={(e) => setPatternChoice(e.target.value)}
                      required
                      aria-describedby={wentOutOn === null ? undefined : hintId}
                      options={[
                        { value: "", label: "Choose the retread pattern" },
                        ...patterns.map((p) => ({ value: p.id, label: p.name })),
                      ]}
                    />
                  </Field>
                  {wentOutOn !== null && (
                    <p className="fleet-hint" id={hintId}>
                      {`Went out on ${wentOutOn}. Choose the pattern it came back on.`}
                    </p>
                  )}
                </>
              )}
            </>
          )}

          <Button type="submit" disabled={outcome === "" || patternBlocked || logReturn.isPending}>
            {logReturn.isPending ? "Logging…" : "Log return"}
          </Button>
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
  // The read Receive uses. FR-CFG-004: a retread comes back on a pattern
  // that applies to retreads, so a new-tyre one is never offered.
  const catalogue = useQuery({
    queryKey: tyreCatalogueKey(tenantKey),
    queryFn: fetchTyreCatalogue,
  });
  const patterns = catalogue.data
    ? catalogue.data.patterns
        .filter((p) => p.appliesTo !== "NEW")
        .sort((a, b) => byNaturalCode(a.name, b.name))
    : null;

  return (
    <section aria-labelledby="retreads-heading" className="fleet-page tr-stack">
      {/* Heading id: see PageHeader's title prop. */}
      <PageHeader
        title={<span id="retreads-heading">Retreads</span>}
        back={{ label: "Back to register", to: "/fleet/tyres" }}
      />

      {closedCode !== null && <p role="status">{`The return for ${closedCode} was logged.`}</p>}

      {jobs.isPending && <p>Loading…</p>}

      {catalogue.isError && catalogue.data === undefined && (
        <Banner
          tone="critical"
          title="The tyre catalogue could not be loaded. Check your connection, then retry."
          action={<Button onClick={() => void catalogue.refetch()}>Retry</Button>}
        />
      )}

      {jobs.isError && (
        <Banner
          tone="critical"
          title={<h2 className="fleet-banner-heading">Retreads didn&apos;t load</h2>}
          action={<Button onClick={() => void jobs.refetch()}>Retry</Button>}
        >
          The server could not be reached. Check your connection, then retry.
        </Banner>
      )}

      {jobs.isSuccess && jobs.data.length === 0 && (
        <p className="fleet-note">No casings are out for retread.</p>
      )}

      {jobs.isSuccess && jobs.data.length > 0 && (
        <Card padding="none">
          <TableScroll label="Retreads table">
            <table className="fleet-table">
              <thead>
                <tr>
                  <th scope="col">Code</th>
                  <th scope="col">Depot</th>
                  <th scope="col">Sent on</th>
                  <th scope="col" data-align="right">
                    Days out
                  </th>
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
                    patterns={patterns}
                    onSuccess={() => setClosedCode(job.displayCode)}
                    onStart={() => setClosedCode(null)}
                  />
                ))}
              </tbody>
            </table>
          </TableScroll>
        </Card>
      )}
    </section>
  );
}
