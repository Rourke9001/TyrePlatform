import { apiGet, apiPost } from "./client";
import { fetchExceptions, type ExceptionRow } from "./dashboard";

// Wire shapes of a unit's inspections (api/internal/httpapi/inspection_reads.go,
// TYRE-325). Every nullable Go field is `T | null`; codes stay strings, since
// the server owns them (me.ts).

export interface UnitInspection {
  inspectionId: string;
  fleetNumber: string;
  state: string;
  latest: boolean;
  voidReason: string | null;
  // A display name, never a user id.
  voidedBy: string | null;
  voidedAt: string | null;
  startedAt: string;
  submittedAt: string;
  receivedAt: string;
  // FR-TYR-017: days since submittedAt in the tenant's calendar.
  ageDays: number;
  driver: { id: string; displayName: string };
  addressedHere: boolean;
  // The unit the capture was addressed to, whose odometer this is (U249).
  // Its id, the odometer and the flag are null when that unit is outside
  // the actor's depots.
  addressedUnit: { fleetNumber: string; vehicleId: string | null };
  odometerKm: number | null;
  // Whether the odometer timeline took the reading (DR-020).
  odometerOnRecord: boolean | null;
  comment: string | null;
  defectReport: string | null;
  positionsRead: number;
  warningCount: number;
}

export interface UnitInspectionPage {
  inspections: UnitInspection[];
  nextAfter: string | null;
  // The unit's latest whatever page holds it; a client never takes it from
  // a page (TYRE-325 Review Focus 1).
  latestInspectionId: string | null;
}

export interface InspectionUnit {
  fleetNumber: string;
  vehicleId: string | null;
  inScope: boolean;
  addressed: boolean;
}

// governingIndex is zero-based and found by the server, which owns the
// minimum (rule 4, CR-011). targetKpa is the tenant's target on the day.
export interface InspectionReading {
  readingId: string;
  positionId: string;
  positionCode: string;
  sequence: number;
  axleNumber: number | null;
  axleClass: string;
  side: string | null;
  slot: string | null;
  isSpare: boolean;
  tyreId: string | null;
  displayCode: string | null;
  governingTreadMm: number | null;
  treadsMm: number[];
  treadAnatomy: string[];
  orientationKnown: boolean | null;
  governingIndex: number | null;
  pressureKpa: number | null;
  pressureBasis: string;
  targetKpa: number | null;
  damageFlag: boolean;
  damageType: string | null;
  wearPattern: string | null;
  note: string | null;
}

export interface AbsentSpare {
  positionId: string;
  positionCode: string;
}

export interface InspectionWarning {
  code: string;
  source: string;
  enteredValue: string | null;
  response: string | null;
  raisedAt: string;
  positionCode: string | null;
}

export interface InspectionDetail {
  inspection: UnitInspection;
  units: InspectionUnit[];
  readings: InspectionReading[];
  absentSpares: AbsentSpare[];
  warnings: InspectionWarning[];
}

// What the unit screen judges condition from (spec section 3): the latest
// inspection and the unit's open exception rows, read together.
export interface UnitCondition {
  latest: InspectionDetail | null;
  exceptions: ExceptionRow[];
}

export function fetchUnitInspections(
  unitId: string,
  after?: string | null,
): Promise<UnitInspectionPage> {
  const query = after ? `?after=${encodeURIComponent(after)}` : "";
  return apiGet<UnitInspectionPage>(`/api/vehicles/${unitId}/inspections${query}`);
}

export function fetchUnitInspection(
  unitId: string,
  inspectionId: string,
): Promise<InspectionDetail> {
  return apiGet<InspectionDetail>(`/api/vehicles/${unitId}/inspections/${inspectionId}`);
}

async function readPair(unitId: string) {
  const [page, body] = await Promise.all([
    fetchUnitInspections(unitId),
    fetchExceptions({ vehicle: unitId }),
  ]);
  return { latestId: page.latestInspectionId, exceptions: body.exceptions };
}

// app.v_exception judges every unit at its latest inspection (000045,
// v_latest_reading), so a row naming another inspection means a capture or
// a void landed between the two reads. Read once more, then fail: dropping
// the row would show a judged position as ok (TYRE-325 red team M1).
export async function fetchUnitCondition(unitId: string): Promise<UnitCondition> {
  const agree = (pair: Awaited<ReturnType<typeof readPair>>) =>
    pair.exceptions.every((row) => row.inspectionId === pair.latestId);
  let pair = await readPair(unitId);
  if (!agree(pair)) {
    pair = await readPair(unitId);
    if (!agree(pair)) throw new Error("the unit's condition changed while it was read");
  }
  const latest = pair.latestId === null ? null : await fetchUnitInspection(unitId, pair.latestId);
  return { latest, exceptions: pair.exceptions };
}

// FR-INS-012: every rule of the void is app.void_inspection's; the server
// adds depot scope (inspections.go).
export function voidInspection(inspectionId: string, reason: string): Promise<void> {
  return apiPost<void>(`/api/inspections/${inspectionId}/void`, { reason });
}
