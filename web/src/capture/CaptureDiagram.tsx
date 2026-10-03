import type { Severity } from "./warnings";
import type { RigPosition } from "./rig";
import { splitSpares } from "./rig";
import "./capture.css";

interface Props {
  positions: RigPosition[];
  // Position ids repeat across same-config units on a rig: cellKey in
  // draft.ts (BR-VEH-003).
  severityOf: (cell: string) => Severity;
  governingOf: (cell: string) => number | null;
  onOpen: (cell: string) => void;
  activeKey: string | null;
  // TYRE-155: an absent spare is a settled observation, not a reading; see
  // markSpareAbsent in draft.ts.
  absentCells: ReadonlySet<string>;
}

interface AxleGroup {
  key: string;
  positions: RigPosition[];
}

interface UnitGroup {
  vehicleId: string;
  // Leads with the unit's own identity (CaptureContext.fleetNumber), never
  // the configuration label alone: two units built from the same
  // configuration carry the identical unitLabel (BR-VEH-003).
  fleetNumber: string;
  // The configuration's own label ("2-axle trailer"), kept as a secondary
  // fact: it tells the driver what layout to expect, but two same-model
  // trailers share it, so it can never stand in for identity on its own.
  configLabel: string | null;
  axles: AxleGroup[];
}

// Grouped by owning unit then by axle within it; the key is
// vehicleId:axleNumber, not axleNumber alone, or a rig's two axle-1s
// collapse into one row. Running positions and spares are grouped
// separately since they draw as separate rows.
function groupRig(cells: RigPosition[]): UnitGroup[] {
  const units: UnitGroup[] = [];
  for (const r of cells) {
    let unit = units.find((u) => u.vehicleId === r.position.vehicleId);
    if (!unit) {
      unit = {
        vehicleId: r.position.vehicleId,
        fleetNumber: r.context.fleetNumber,
        configLabel: r.position.unitLabel,
        axles: [],
      };
      units.push(unit);
    }
    const axleKey = `${r.position.vehicleId}:${r.position.axleNumber}`;
    let axle = unit.axles.find((a) => a.key === axleKey);
    if (!axle) {
      axle = { key: axleKey, positions: [] };
      unit.axles.push(axle);
    }
    axle.positions.push(r);
  }
  return units;
}

// Plan view, nose up. The same frame BR-VEH-001 numbers positions in and the
// frame FR-INS-029a means by "left-to-right". Every entry screen in the app
// shows the vehicle this way round so the driver learns one picture.
export function CaptureDiagram({
  positions,
  severityOf,
  governingOf,
  onOpen,
  activeKey,
  absentCells,
}: Props) {
  const { running, spares } = splitSpares(positions);
  const units = groupRig(running);

  return (
    <div className="cap-diagram">
      {units.map((unit, i) => (
        <div key={unit.vehicleId} className="cap-unit">
          {/* FR-INS-060/FR-INS-061: shows the coupling itself, once between
              units, rather than repeating a unit's own label on every axle
              it owns. */}
          {i > 0 && <CouplingMark />}
          <p className="cap-unitband">
            <span className="cap-unitband-id">{unit.fleetNumber}</span>
            {unit.configLabel && <span className="cap-unitband-note"> {unit.configLabel}</span>}
          </p>
          {unit.axles.map((axle) => (
            <div key={axle.key} className="cap-axle">
              <div className="cap-beam" aria-hidden="true" />
              {axle.positions.map((r) => (
                <PositionCell
                  key={r.key}
                  rig={r}
                  severity={severityOf(r.key)}
                  governing={governingOf(r.key)}
                  active={activeKey === r.key}
                  onOpen={onOpen}
                  absent={absentCells.has(r.key)}
                />
              ))}
            </div>
          ))}
        </div>
      ))}
      {/* A row per unit: every configuration carries a spare count, so a
          rig draws one S cell per unit. Under one shared band they are
          identical, and nothing on entry or after tells them apart
          (BR-VEH-003). */}
      {groupRig(spares).map((unit) => {
        const cells = unit.axles.flatMap((axle) => axle.positions);
        return (
          <div key={`spare-${unit.vehicleId}`} className="cap-unit">
            <p className="cap-unitband">
              <span className="cap-unitband-id">{unit.fleetNumber}</span>
              <span className="cap-unitband-note"> {cells.length === 1 ? "spare" : "spares"}</span>
            </p>
            <div className="cap-axle cap-axle--spare">
              {cells.map((r) => (
                <PositionCell
                  key={r.key}
                  rig={r}
                  severity={severityOf(r.key)}
                  governing={governingOf(r.key)}
                  active={activeKey === r.key}
                  onOpen={onOpen}
                  absent={absentCells.has(r.key)}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// A hitch-and-pin mark between member units. The projection numbers straight
// through the coupling (FR-VEH-034); the picture keeps it visible, since a
// driver reads the rig as one walk, not as several unrelated lists.
function CouplingMark() {
  return (
    <svg className="cap-coupling" viewBox="0 0 32 12" width="32" height="12" aria-hidden="true">
      <line x1="0" y1="6" x2="12" y2="6" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="16" cy="6" r="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <line x1="20" y1="6" x2="32" y2="6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

const SEVERITY_LABEL: Record<Severity, string> = {
  roadworthy: "OK",
  caution: "Check",
  "below-removal": "Report",
  unmeasured: "Not done",
};

function PositionCell({
  rig,
  severity,
  governing,
  active,
  onOpen,
  absent,
}: {
  rig: RigPosition;
  severity: Severity;
  governing: number | null;
  active: boolean;
  onOpen: (cell: string) => void;
  // TYRE-155: a spare the driver has already reported absent. Words, not
  // colour alone (NFR-USE-009). The accessible name says so too.
  absent: boolean;
}) {
  const name = rig.displayNumber === null ? "Spare" : `Position ${rig.displayNumber}`;
  // TYRE-155: an absent cell is settled, not unmeasured. The severity band
  // was computed with nothing entered (draft.ts discards the position the
  // same tap that records the mark), so showing SEVERITY_LABEL's "Not done"
  // here would contradict the "done" the header and tally already count it
  // as. "No spare" replaces the band entirely rather than appending to it.
  const badge = absent ? "No spare" : SEVERITY_LABEL[severity];
  return (
    <button
      type="button"
      // Any-order completion (FR-INS-048's walk-around reality): a driver
      // works round the vehicle in whatever order the yard allows, not in the
      // order a form dictates.
      className={`cap-pos cap-pos--${severity}${active ? " is-active" : ""}${absent ? " is-absent" : ""}`}
      data-position-id={rig.position.id}
      aria-label={`${name}, ${rig.context.fleetNumber}${absent ? ", no spare" : `, ${SEVERITY_LABEL[severity]}`}`}
      onClick={() => onOpen(rig.key)}
    >
      <span className="cap-pos-n">{rig.displayNumber ?? "S"}</span>
      <span className="cap-pos-v">
        {absent ? "none" : governing === null ? "—" : `${governing}mm`}
      </span>
      {/* NFR-USE-009: colour is never the only encoding. The badge says it in
          words, and it is the thing that survives direct sunlight. */}
      <span className="cap-pos-badge">{badge}</span>
    </button>
  );
}
