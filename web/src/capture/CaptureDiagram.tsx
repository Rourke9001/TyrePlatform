import { AxleDiagram, type DiagramPosition, type DiagramUnit } from "../ui/AxleDiagram";
import type { Condition } from "../ui/condition";
import { placeWords } from "./place";
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

const SEVERITY_LABEL: Record<Severity, string> = {
  roadworthy: "OK",
  caution: "Check",
  "below-removal": "Report",
  unmeasured: "Not done",
};

// The tile's colour follows capture's own band (warnings.ts); the tile
// judges nothing itself (rule 5).
const CONDITION: Record<Severity, Condition> = {
  roadworthy: "ok",
  caution: "near",
  "below-removal": "limit",
  unmeasured: "unread",
};

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

  const tile = (r: RigPosition): DiagramPosition => {
    const severity = severityOf(r.key);
    const governing = governingOf(r.key);
    // TYRE-155: an absent cell is settled, not unmeasured. The severity band
    // was computed with nothing entered (draft.ts discards the position the
    // same tap that records the mark), so showing SEVERITY_LABEL's "Not done"
    // here would contradict the "done" the header and tally already count it
    // as. "No spare" replaces the band entirely rather than appending to it.
    const absent = absentCells.has(r.key);
    const name = r.displayNumber === null ? "Spare" : `Position ${r.displayNumber}`;
    const place = placeWords(r);
    return {
      id: r.key,
      label: r.displayNumber === null ? "S" : String(r.displayNumber),
      valueText: absent ? "none" : governing === null ? "—" : `${governing}mm`,
      // NFR-USE-009: colour is never the only encoding. The badge says it in
      // words, and it is the thing that survives direct sunlight.
      badgeText: absent ? "No spare" : SEVERITY_LABEL[severity],
      condition: absent ? "nospare" : CONDITION[severity],
      ariaLabel: `${name}, ${r.context.fleetNumber}${absent ? ", no spare" : `, ${SEVERITY_LABEL[severity]}`}${place ? `, ${place}` : ""}`,
      dataPositionId: r.position.id,
      active: activeKey === r.key,
    };
  };

  const units: DiagramUnit[] = [
    ...groupRig(running).map((unit, i) => ({
      id: unit.vehicleId,
      unitHeading: unit.fleetNumber,
      description: unit.configLabel ?? undefined,
      // FR-INS-060/FR-INS-061: the hitch between units, once, rather than a
      // unit's own label on every axle it owns. The projection numbers
      // straight through it (FR-VEH-034).
      coupled: i > 0,
      axles: unit.axles.map((axle) => ({ id: axle.key, positions: axle.positions.map(tile) })),
    })),
    // A row per unit: every configuration carries a spare count, so a rig
    // draws one S cell per unit. Under one shared band they are identical,
    // and nothing on entry or after tells them apart (BR-VEH-003).
    ...groupRig(spares).map((unit) => {
      const cells = unit.axles.flatMap((axle) => axle.positions);
      return {
        id: `spare-${unit.vehicleId}`,
        unitHeading: unit.fleetNumber,
        description: cells.length === 1 ? "spare" : "spares",
        axles: [],
        spares: cells.map(tile),
      };
    }),
  ];

  // Any-order completion (FR-INS-048's walk-around reality): a driver works
  // round the vehicle in whatever order the yard allows, not in the order a
  // form dictates.
  return <AxleDiagram units={units} onSelect={(p) => onOpen(p.id)} />;
}
