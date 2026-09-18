import Dexie, { type EntityTable } from "dexie";

import type { WarningCode } from "./warnings";

// FR-INS-040/DR-021: the code, value and response. Null when the driver
// left without answering; app.inspection_warning.response is nullable with
// no CHECK precisely so absence is recorded as absence
// (000022_inspection_warning).
export interface RecordedWarning {
  code: WarningCode;
  enteredValue: string | null;
  response: "ACKNOWLEDGED" | "CONFIRMED" | null;
}

// A position row belongs to an axle CONFIGURATION, not a vehicle, so two
// units of one configuration share every position id (the two links of a
// superlink, the ordinary case). The reading's identity is therefore the
// pair, matching app.reading's (inspection_id, position_id, vehicle_id) key
// (BR-VEH-003).
export function cellKey(vehicleId: string, positionId: string): string {
  return `${vehicleId}:${positionId}`;
}

export interface DraftPosition {
  positionId: string;
  // The unit that OWNS the position, which on a rig is not the motive vehicle
  // (FR-INS-061). Rig-level numbering never appears here or on the wire.
  vehicleId: string;
  tyreId: string | null;
  // Entry order, left to right in the plan view (FR-INS-029a). The server maps
  // to OUTER/CENTRE/INNER by side on save; this array is never reordered.
  treads: (number | null)[];
  pressureKpa: number | null;
  pressureTemperature: "HOT" | "COLD" | "UNKNOWN";
  damageFlag: boolean;
  note: string | null;
  // NFR-OBS-007: median time-per-position, measured rather than assumed. It
  // cannot be retrofitted onto inspections already captured, which is why it
  // rides here from the first one.
  seconds: number;
  warnings: RecordedWarning[];
}

export interface Draft {
  clientUuid: string;
  vehicleId: string;
  // Named on the held-vehicle screen (CaptureFlow), which is shown exactly
  // when this vehicle's context has NOT been fetched, so the name rides in
  // the draft. Null on a draft written before the field existed; the screen
  // then says "the other vehicle" rather than inventing one.
  fleetNumber: string | null;
  combinationId: string | null;
  // FR-INS-062/063: what the driver confirmed was attached. The server records
  // a difference as an observation; it never creates a combination on submit.
  observedMemberVehicleIds: string[];
  taskId: string | null;
  startedAt: string;
  odometerKm: number | null;
  comment: string | null;
  defectReport: string | null;
  // Keyed by cellKey, never by position id. See cellKey for why the pair is
  // the identity.
  positions: Record<string, DraftPosition>;
  warnings: RecordedWarning[];
  // TYRE-155/FR-INS-066: spares the driver said this unit does not carry;
  // see markSpareAbsent below.
  absentSpares: { vehicleId: string; positionId: string }[];
}

// The single row's fixed key. One in-progress inspection, whose lifetime is
// minutes or hours (FR-OFF-007 withdrawn in v1.4), not a sync queue.
const DRAFT_KEY = "current";

interface DraftRow {
  key: string;
  draft: Draft;
}

const database = new Dexie("tyre-capture") as Dexie & {
  drafts: EntityTable<DraftRow, "key">;
};
database.version(1).stores({ drafts: "key", outbox: "clientUuid, state" });

export const db = database;

// The persisted draft is one unversioned JSON blob, so a shape change meets
// an older row with no schema to refuse it, silently: an unreachable key
// reads as an untouched vehicle and a re-entered position lands beside it
// instead of replacing it. Rebuilt from the values instead: DraftPosition
// names its own unit and position, so every entry is self-describing
// whatever it is filed under, and Object.values' insertion order makes the
// newer write win a collision.
function byCell(positions: Record<string, DraftPosition>): Record<string, DraftPosition> {
  const out: Record<string, DraftPosition> = {};
  for (const p of Object.values(positions)) out[cellKey(p.vehicleId, p.positionId)] = p;
  return out;
}

// One JSON blob under no schema: a draft written before a field existed
// comes back without it, and a callback that filters/some's a missing
// absentSpares throws. The one durable in-progress draft (ADR-0009) must
// never be blocked by that.
function normalise(draft: Draft): Draft {
  return {
    ...draft,
    fleetNumber: draft.fleetNumber ?? null,
    positions: byCell(draft.positions),
    absentSpares: draft.absentSpares ?? [],
  };
}

export async function loadDraft(): Promise<Draft | undefined> {
  const row = await db.drafts.get(DRAFT_KEY);
  if (!row) return undefined;
  return normalise(row.draft);
}

export async function startDraft(init: {
  vehicleId: string;
  taskId: string | null;
  startedAt: string;
  fleetNumber?: string | null;
  combinationId?: string | null;
  observedMemberVehicleIds?: string[];
}): Promise<Draft> {
  const existing = await loadDraft();
  if (existing) {
    // FR-OFF-014: never silently discard. The caller decides: finish it,
    // queue it, or explicitly abandon it, because only a person can.
    throw new Error("An inspection is already in progress on this device.");
  }
  const draft: Draft = {
    // Generated at start, not at send: FR-OFF-011 keys idempotency on it, so
    // a value that changed per attempt would turn every retry into a new
    // inspection.
    clientUuid: crypto.randomUUID(),
    vehicleId: init.vehicleId,
    fleetNumber: init.fleetNumber ?? null,
    combinationId: init.combinationId ?? null,
    observedMemberVehicleIds: init.observedMemberVehicleIds ?? [],
    taskId: init.taskId,
    startedAt: init.startedAt,
    odometerKm: null,
    comment: null,
    defectReport: null,
    positions: {},
    warnings: [],
    absentSpares: [],
  };
  await db.drafts.put({ key: DRAFT_KEY, draft });
  return draft;
}

async function mutate(fn: (draft: Draft) => Draft): Promise<void> {
  await db.transaction("rw", db.drafts, async () => {
    const row = await db.drafts.get(DRAFT_KEY);
    if (!row) throw new Error("No inspection in progress.");
    await db.drafts.put({ key: DRAFT_KEY, draft: fn(normalise(row.draft)) });
  });
}

export async function savePosition(position: DraftPosition): Promise<void> {
  await mutate((draft) => ({
    ...draft,
    positions: {
      ...draft.positions,
      [cellKey(position.vehicleId, position.positionId)]: position,
    },
    // TYRE-155: a reading reverses markSpareAbsent's mark; canonical
    // rationale below.
    absentSpares: draft.absentSpares.filter(
      (s) => !(s.vehicleId === position.vehicleId && s.positionId === position.positionId),
    ),
  }));
}

export async function saveHeader(patch: {
  odometerKm?: number | null;
  comment?: string | null;
  defectReport?: string | null;
  combinationId?: string | null;
  observedMemberVehicleIds?: string[];
  warnings?: RecordedWarning[];
}): Promise<void> {
  await mutate((draft) => ({ ...draft, ...patch }));
}

// TYRE-155/FR-INS-066: one tap on the spare sheet, recorded as an
// observation. Idempotent on the mark: a stale double-tap must not double
// the row app.submit_inspection would otherwise reject as a repeat reading
// (000041, TY005 in reverse).
export async function markSpareAbsent(vehicleId: string, positionId: string): Promise<void> {
  const cell = cellKey(vehicleId, positionId);
  await mutate((draft) => ({
    ...draft,
    // TY005/000041: a reading and an absent_spares entry on the same cell
    // is refused outright, and the outbox treats that 422 as permanent.
    // Discarded in the same mutate as the mark so the combination is
    // unreachable, not merely filtered downstream.
    positions: Object.fromEntries(Object.entries(draft.positions).filter(([key]) => key !== cell)),
    absentSpares: draft.absentSpares.some(
      (s) => s.vehicleId === vehicleId && s.positionId === positionId,
    )
      ? draft.absentSpares
      : [...draft.absentSpares, { vehicleId, positionId }],
  }));
}

// TYRE-155: unmarking does not restore the discarded reading; canonical
// rationale at markSpareAbsent above.
export async function unmarkSpareAbsent(vehicleId: string, positionId: string): Promise<void> {
  await mutate((draft) => ({
    ...draft,
    absentSpares: draft.absentSpares.filter(
      (s) => !(s.vehicleId === vehicleId && s.positionId === positionId),
    ),
  }));
}

export async function clearDraft(): Promise<void> {
  await db.drafts.delete(DRAFT_KEY);
}
