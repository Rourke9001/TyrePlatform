import Dexie, { type EntityTable } from "dexie";

import type { WarningCode } from "./warnings";

// FR-INS-040 / DR-021: the code, the value that provoked it and what the
// driver did about it. The response is what the paper trail turns on months
// later, so it is captured here rather than reconstructed at submit.
//
// Null when the driver left the position without answering — closing the sheet
// is not acknowledging. app.inspection_warning.response is nullable with no
// CHECK for exactly this case (000022_inspection_warning), so absence is
// recorded as absence; a "DISMISSED" or "UNANSWERED" value invented here would
// be a fiction the column was deliberately shaped to avoid.
export interface RecordedWarning {
  code: WarningCode;
  enteredValue: string | null;
  response: "ACKNOWLEDGED" | "CONFIRMED" | null;
}

// A position row belongs to an axle CONFIGURATION, not to a vehicle
// (app.position.configuration_id), so two units of the same configuration —
// the two links of a superlink, the ordinary case — share every position id.
// The identity of a reading is therefore the pair, which is exactly what
// app.reading's (inspection_id, position_id, vehicle_id) unique key states and
// what BR-VEH-003 means by attributing every reading to the unit that owns the
// position. Anything on the device keyed by position id alone silently
// collapses two units into one and sends one of them nowhere.
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
  combinationId: string | null;
  // FR-INS-062/063: what the driver confirmed was attached. The server records
  // a difference as an observation; it never creates a combination on submit.
  observedMemberVehicleIds: string[];
  taskId: string | null;
  startedAt: string;
  odometerKm: number | null;
  comment: string | null;
  defectReport: string | null;
  // Keyed by cellKey, never by position id — see cellKey for why the pair is
  // the identity.
  positions: Record<string, DraftPosition>;
  warnings: RecordedWarning[];
}

// The single row's fixed key. One in-progress inspection, whose lifetime is
// minutes or hours (FR-OFF-007 withdrawn in v1.4) — not a sync queue.
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

// Nothing versions the shape of the persisted draft: it is one JSON blob in one
// row, so a change to cellKey or to DraftPosition meets a row written under a
// different shape with no schema to refuse it and no error to raise. That
// failure is silent and expensive — a key the reader cannot match reads back as
// an untouched vehicle under a header counting it done, and a position entered
// again lands beside the unreachable entry instead of replacing it, so the
// submit carries the same wheel twice.
//
// Rebuilding from the values removes the dependency on the keys altogether:
// DraftPosition names its own unit and its own position, so every entry is
// self-describing whatever it happens to be filed under. Last one wins on a
// collision, which is the right answer — Object.values keeps insertion order,
// so an entry written under a superseded key is overwritten by the one written
// after it.
function byCell(positions: Record<string, DraftPosition>): Record<string, DraftPosition> {
  const out: Record<string, DraftPosition> = {};
  for (const p of Object.values(positions)) out[cellKey(p.vehicleId, p.positionId)] = p;
  return out;
}

export async function loadDraft(): Promise<Draft | undefined> {
  const row = await db.drafts.get(DRAFT_KEY);
  if (!row) return undefined;
  return { ...row.draft, positions: byCell(row.draft.positions) };
}

export async function startDraft(init: {
  vehicleId: string;
  taskId: string | null;
  startedAt: string;
  combinationId?: string | null;
  observedMemberVehicleIds?: string[];
}): Promise<Draft> {
  const existing = await loadDraft();
  if (existing) {
    // FR-OFF-014: never silently discard. The caller decides — finish it,
    // queue it, or explicitly abandon it — because only a person can.
    throw new Error("An inspection is already in progress on this device.");
  }
  const draft: Draft = {
    // Generated at start, not at send: FR-OFF-011 keys idempotency on it, so
    // a value that changed per attempt would turn every retry into a new
    // inspection.
    clientUuid: crypto.randomUUID(),
    vehicleId: init.vehicleId,
    combinationId: init.combinationId ?? null,
    observedMemberVehicleIds: init.observedMemberVehicleIds ?? [],
    taskId: init.taskId,
    startedAt: init.startedAt,
    odometerKm: null,
    comment: null,
    defectReport: null,
    positions: {},
    warnings: [],
  };
  await db.drafts.put({ key: DRAFT_KEY, draft });
  return draft;
}

async function mutate(fn: (draft: Draft) => Draft): Promise<void> {
  await db.transaction("rw", db.drafts, async () => {
    const row = await db.drafts.get(DRAFT_KEY);
    if (!row) throw new Error("No inspection in progress.");
    await db.drafts.put({ key: DRAFT_KEY, draft: fn(row.draft) });
  });
}

export async function savePosition(position: DraftPosition): Promise<void> {
  await mutate((draft) => ({
    ...draft,
    positions: {
      ...draft.positions,
      [cellKey(position.vehicleId, position.positionId)]: position,
    },
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

export async function clearDraft(): Promise<void> {
  await db.drafts.delete(DRAFT_KEY);
}
