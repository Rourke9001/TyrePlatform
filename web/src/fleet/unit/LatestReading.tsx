import { Link } from "react-router";

import type { UnitInspection } from "../../api/inspections";
import { severityLabel } from "../../domain/vocabulary";
import { formatTreadAge } from "../../format/treadAge";
import { TreadReadings } from "../../ui/TreadReadings";
import { useUnitLabels } from "../../units/units";
import type { PositionState } from "./condition.view";
import { pressureText, readingCells } from "./inspection.view";

// The selected position at the unit's latest inspection (TYRE-325 spec
// section 3): its width-wise readings with the stored minimum marked
// (CR-011, FR-RPT-015), its pressure against the day's target, its age and
// its open exceptions, or why there is no reading to show.
export function LatestReading({
  unitId,
  state,
  latest,
}: {
  unitId: string;
  state: PositionState | undefined;
  latest: UnitInspection | null;
}) {
  const units = useUnitLabels();
  if (state === undefined || state.why === "empty") return null;

  const link =
    latest === null ? null : (
      <Link to={`/fleet/units/${unitId}/inspections/${latest.inspectionId}`}>
        Open the inspection
      </Link>
    );

  return (
    <div className="unit-latest">
      <h3 className="unit-latest-heading">Latest inspection</h3>
      {state.why === "never" && <p className="unit-note">No inspection has read this unit yet.</p>}
      {state.why === "not-read" && <p className="unit-note">Not read at the latest inspection.</p>}
      {state.why === "absent" && (
        <p className="unit-note">Reported absent at the latest inspection.</p>
      )}
      {state.why === "other-tyre" && (
        <p className="unit-note">This tyre has not been read since it was fitted.</p>
      )}
      {state.why === "read" && state.reading !== null && (
        <>
          {state.reading.treadsMm.length === 0 ? (
            <p className="unit-note">No tread entered.</p>
          ) : (
            // No condition prop: a position's condition can come from a
            // pressure or dual-mate rule, and tinting the tread mark with it
            // would colour a good tread (NFR-USE-009).
            <TreadReadings {...readingCells(state.reading)} governingText="Lowest" />
          )}
          <p className="unit-latest-line">{pressureText(state.reading, units.pressure)}</p>
          {latest !== null && (
            <p className="unit-latest-line">Read {formatTreadAge(latest.ageDays)}</p>
          )}
          {state.exceptions.length === 0 ? (
            <p className="unit-note">No open exceptions on this position.</p>
          ) : (
            <ul className="unit-latest-rules" aria-label="Open exceptions">
              {state.exceptions.map((row) => (
                <li key={`${row.ruleCode}-${row.subjectId}`}>
                  {`${row.ruleName}: ${severityLabel(row.severity)}`}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {state.why !== "never" && state.why !== "other-tyre" && link}
    </div>
  );
}
