import type { Severity } from "./warnings";
import type { RigPosition } from "./rig";
import "./capture.css";

interface Props {
  positions: RigPosition[];
  // Addressed by RigPosition.key, never by position id: two member units of
  // the same axle configuration share every position id, so an id alone cannot
  // name a wheel on a rig (draft.cellKey).
  severityOf: (cell: string) => Severity;
  governingOf: (cell: string) => number | null;
  onOpen: (cell: string) => void;
  activeKey: string | null;
}

interface AxleGroup {
  key: string;
  positions: RigPosition[];
}

interface UnitGroup {
  vehicleId: string;
  // The unit's own identity (app.vehicle, via CaptureContext.fleetNumber),
  // never the configuration label alone: app.position belongs to an axle
  // CONFIGURATION, not a vehicle, so two member units built from the same
  // configuration (an ordinary superlink's two trailers) carry the identical
  // unitLabel. Leading with fleetNumber is what BR-VEH-003 needs — a driver
  // tells units apart by what is painted on them, not by list order.
  fleetNumber: string;
  // The configuration's own label ("2-axle trailer"), kept as a secondary
  // fact: it tells the driver what layout to expect, but two same-model
  // trailers share it, so it can never stand in for identity on its own.
  configLabel: string | null;
  axles: AxleGroup[];
}

// One pass, grouped by the unit that owns each position and then by axle
// within it. The axle key is vehicleId:axleNumber, not axleNumber alone — on
// a rig the horse's axle 1 and the trailer's axle 1 are different axles that
// would otherwise collapse into one row. Building groups with find() rather
// than assuming contiguous runs keeps this correct however `positions`
// arrives, the same defensiveness rigPositions applies by sorting on
// sequence rather than trusting API order.
function groupRig(running: RigPosition[]): UnitGroup[] {
  const units: UnitGroup[] = [];
  for (const r of running) {
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

// Plan view, nose up — the same frame BR-VEH-001 numbers positions in and the
// frame FR-INS-029a means by "left-to-right". Every entry screen in the app
// shows the vehicle this way round so the driver learns one picture.
export function CaptureDiagram({ positions, severityOf, governingOf, onOpen, activeKey }: Props) {
  const running = positions.filter((r) => r.displayNumber !== null);
  const spares = positions.filter((r) => r.displayNumber === null);
  const units = groupRig(running);

  return (
    <div className="cap-diagram">
      {units.map((unit, i) => (
        <div key={unit.vehicleId} className="cap-unit">
          {/* FR-INS-060/FR-INS-061: a driver walks one coupled rig built from
              independent units. The mark shows the coupling itself, once
              between units, rather than repeating a unit's own label on
              every axle it owns. */}
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
                />
              ))}
            </div>
          ))}
        </div>
      ))}
      {spares.length > 0 && (
        <div className="cap-unit">
          <p className="cap-unitband">Spare</p>
          <div className="cap-axle cap-axle--spare">
            {spares.map((r) => (
              <PositionCell
                key={r.key}
                rig={r}
                severity={severityOf(r.key)}
                governing={governingOf(r.key)}
                active={activeKey === r.key}
                onOpen={onOpen}
              />
            ))}
          </div>
        </div>
      )}
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
}: {
  rig: RigPosition;
  severity: Severity;
  governing: number | null;
  active: boolean;
  onOpen: (cell: string) => void;
}) {
  const name = rig.displayNumber === null ? "Spare" : `Position ${rig.displayNumber}`;
  return (
    <button
      type="button"
      // Any-order completion (FR-INS-048's walk-around reality): a driver
      // works round the vehicle in whatever order the yard allows, not in the
      // order a form dictates.
      className={`cap-pos cap-pos--${severity}${active ? " is-active" : ""}`}
      data-position-id={rig.position.id}
      aria-label={`${name}, ${rig.context.fleetNumber}, ${SEVERITY_LABEL[severity]}`}
      onClick={() => onOpen(rig.key)}
    >
      <span className="cap-pos-n">{rig.displayNumber ?? "S"}</span>
      <span className="cap-pos-v">{governing === null ? "—" : `${governing}mm`}</span>
      {/* NFR-USE-009: colour is never the only encoding. The badge says it in
          words, and it is the thing that survives direct sunlight. */}
      <span className="cap-pos-badge">{SEVERITY_LABEL[severity]}</span>
    </button>
  );
}
