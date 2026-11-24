import type {
  AbsentSpare,
  InspectionDetail,
  InspectionReading,
  InspectionWarning,
  UnitInspection,
} from "../../api/inspections";
import { diagramSide } from "../../domain/side";
import { pressureBasisLabel } from "../../domain/vocabulary";
import { formatCount, formatMm } from "../../format/numbers";
import { byNaturalCode } from "./naturalOrder";

// The inspection list's and page's view model (TYRE-325, ADR-0022): pure
// functions from the wire to what the screens show, tested without React.

// U249: the odometer is the addressed unit's. A towed unit's row names that
// unit beside it, and nothing here works out a distance (FR-INS-064).
export function odometerCell(row: UnitInspection, distanceUnit: string): string {
  const refused = row.odometerOnRecord === false ? " (not on the odometer record)" : "";
  const reading =
    row.odometerKm === null ? null : `${formatCount(row.odometerKm)} ${distanceUnit}${refused}`;
  if (row.addressedHere) return reading ?? "Not recorded";
  const name = row.addressedUnit.fleetNumber;
  return reading === null ? name : `${name}: ${reading}`;
}

// A voided inspection is never the latest (000045), and says so first.
export function inspectionMark(row: UnitInspection): "latest" | "voided" | null {
  if (row.state === "VOIDED") return "voided";
  return row.latest ? "latest" : null;
}

// `when` is the caller's tenant-time text for voidedAt (rule 6).
export function voidedText(row: UnitInspection, when: string | null): string {
  const who = row.voidedBy === null ? "" : ` by ${row.voidedBy}`;
  const at = when === null ? "" : ` on ${when}`;
  const why = row.voidReason === null ? "" : ` Reason: ${row.voidReason}.`;
  return `Voided${who}${at}.${why}`;
}

// The order TreadReadings names three cells in from each side.
const DRAWN: Record<"left" | "right", readonly string[]> = {
  left: ["OUTER", "CENTRE", "INNER"],
  right: ["INNER", "CENTRE", "OUTER"],
};

export interface ReadingCells {
  readings: string[];
  unitText: "mm";
  governingIndex: number | null;
  naming: "named" | "numbered";
  side?: "left" | "right";
}

// TreadReadings' own idiom: the bare figure in the cell, the unit apart,
// one decimal with a point as formatMm writes it. Cells are named only where
// the stored anatomy is the order TreadReadings draws for that side, so a
// drawn name is always the stored one (CHG-010, FR-INS-029a errata).
export function readingCells(r: InspectionReading): ReadingCells {
  const readings = r.treadsMm.map((mm) => mm.toFixed(1));
  const governingIndex = readings.length === 0 ? null : r.governingIndex;
  const side = diagramSide(r.side);
  const named =
    side !== undefined &&
    r.orientationKnown === true &&
    r.treadAnatomy.length === 3 &&
    DRAWN[side].every((a, i) => r.treadAnatomy[i] === a);
  return named
    ? { readings, unitText: "mm", governingIndex, naming: "named", side }
    : { readings, unitText: "mm", governingIndex, naming: "numbered" };
}

// FR-CFG-013: the reading beside the target in force that day. No
// percentage and no band: nothing here judges it (TYRE-325 Lead's call 11).
export function pressureText(r: InspectionReading, pressureUnit: string): string {
  if (r.pressureKpa === null) return "Not entered";
  const basis = pressureBasisLabel(r.pressureBasis);
  if (r.targetKpa !== null) {
    return `${formatCount(r.pressureKpa)} of ${formatCount(r.targetKpa)} ${pressureUnit}, ${basis}`;
  }
  const none = r.isSpare ? "no target for a spare" : "no target set";
  return `${formatCount(r.pressureKpa)} ${pressureUnit}, ${basis}, ${none}`;
}

export type InspectionRow =
  { kind: "reading"; reading: InspectionReading } | { kind: "absent"; spare: AbsentSpare };

function codeOf(row: InspectionRow): string {
  return row.kind === "reading" ? row.reading.positionCode : row.spare.positionCode;
}

// One row per position, a spare reported absent among the readings, in
// natural order (NFR-USE-012).
export function inspectionRows(detail: InspectionDetail): InspectionRow[] {
  const rows: InspectionRow[] = [
    ...detail.readings.map((reading) => ({ kind: "reading" as const, reading })),
    ...detail.absentSpares.map((spare) => ({ kind: "absent" as const, spare })),
  ];
  return rows.sort((a, b) => byNaturalCode(codeOf(a), codeOf(b)));
}

// What each warning's entered value measures. A code not listed shows no
// value: FR-INS-063's is a list of unit ids (spec section 4).
const VALUE_KIND: Record<string, "mm" | "pressure" | "distance"> = {
  "FR-INS-034": "mm",
  "FR-INS-035": "mm",
  "FR-INS-036": "mm",
  "FR-INS-041": "mm",
  "FR-INS-031a": "pressure",
  "FR-INS-037": "pressure",
  "FR-INS-033": "distance",
  "DR-020": "distance",
};

export function warningValueText(
  w: InspectionWarning,
  units: { pressure: string; distance: string },
): string | null {
  const kind = VALUE_KIND[w.code] as "mm" | "pressure" | "distance" | undefined;
  if (kind === undefined || w.enteredValue === null || w.enteredValue.trim() === "") return null;
  const n = Number(w.enteredValue);
  if (!Number.isFinite(n)) return null;
  if (kind === "mm") return formatMm(n);
  return `${formatCount(n)} ${kind === "pressure" ? units.pressure : units.distance}`;
}
