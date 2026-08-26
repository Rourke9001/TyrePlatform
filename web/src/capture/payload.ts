import type { Draft, DraftPosition, RecordedWarning } from "./draft";
import { cellKey } from "./draft";
import { treadsRead } from "./warnings";

// Wire shape of POST /api/inspections. snake_case because the body reaches
// app.submit_inspection(jsonb) and is read with SQL-style keys — deliberately
// unlike the camelCase GET response, which Go struct tags shape.
export interface SubmitWarning {
  code: string;
  entered_value: string | null;
  response: string | null;
}

export interface SubmitReading {
  vehicle_id: string;
  position_id: string;
  tyre_id: string | null;
  pressure_kpa: number | null;
  pressure_temperature: string;
  damage_flag: boolean;
  note: string | null;
  treads: number[];
  granularity_mm: number;
  seconds: number;
  warnings: SubmitWarning[];
}

export interface SubmitPayload {
  client_uuid: string;
  vehicle_id: string;
  combination_id: string | null;
  observed_member_vehicle_ids: string[];
  task_id: string | null;
  started_at: string;
  submitted_at: string;
  odometer_km: number | null;
  // app.inspection.duration_seconds CHECK (duration_seconds >= 0)
  // (db/migrations/000001_init.up.sql) — negative is not clamped, it is
  // omitted. See durationSeconds() below.
  duration_seconds: number | null;
  // app.inspection.completeness_pct defaults to 100, so a partial
  // inspection submitted without this is stored as complete — and
  // FR-INS-047's coverage figure then counts it as one (NFR-PRO-003
  // forbids exactly that kind of silent flattery).
  completeness_pct: number;
  comment: string | null;
  defect_report: string | null;
  device_id: string;
  app_version: string;
  readings: SubmitReading[];
  warnings: SubmitWarning[];
}

export interface SubmitMeta {
  submittedAt: string;
  granularityMm: number;
  deviceId: string;
  appVersion: string;
  // Every position across every member unit, from the capture contexts —
  // the denominator the draft itself does not know.
  totalPositions: number;
}

// NFR-OBS-004 records submit success rate per device, so the id has to be
// stable across sessions — which means localStorage, and which is NOT a
// breach of FR-OFF-002: that prohibits caching the fleet REFERENCE DATA on
// the device, not a random opaque string that identifies nobody. It carries
// no personal information (NFR-PRV-002) and survives a cleared browser only
// by being regenerated.
const DEVICE_KEY = "tyre.device-id";

export function deviceId(): string {
  try {
    const held = window.localStorage.getItem(DEVICE_KEY);
    if (held) return held;
    const fresh = crypto.randomUUID();
    window.localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    // Private mode: an unattributable submit beats a failed one.
    return "unknown";
  }
}

// Vite replaces this at build time (vite.config.ts's `define`), stamped from
// package.json so a deployed bundle traces back to a release (NFR-OBS-004).
export const appVersion = __APP_VERSION__;

const wire = (w: RecordedWarning): SubmitWarning => ({
  code: w.code,
  entered_value: w.enteredValue,
  response: w.response,
});

// A phone clock that steps backwards mid-inspection — an NTP correction, or a
// driver changing it — makes this negative, which fails the column's CHECK
// and comes back 422. The outbox reads 422 as permanent, so a completed
// inspection would be discarded with no retry that could ever fix it.
//
// Null rather than a clamp to zero, deliberately: NFR-USE-001's three-minute
// median is computed from this column, so a fabricated 0 drags the project's
// own acceptance metric down. NFR-PRO-003 forbids exactly that flattery. An
// absent duration is honest; a zero is not.
function durationSeconds(startedAt: string, submittedAt: string): number | null {
  const elapsed = Math.round(
    (new Date(submittedAt).getTime() - new Date(startedAt).getTime()) / 1000,
  );
  return elapsed < 0 ? null : elapsed;
}

// FR-OFF-005 writes a position on the FIRST digit, so an abandoned position
// sits in the draft half-entered. Its tread array would fail the configured
// tread-count check (TY005 -> 422, which the outbox treats as permanent), so it
// cannot be sent and completeness reports the shortfall instead.
//
// Pressure is the opposite case and deliberately not required: 000023 accepts a
// NULL pressure by design (BR-RPT-001, NFR-PRO-003 — absent, never zero).
// Requiring one here would discard a position whose treads are complete, and
// the draft is cleared on submit, so those readings would be gone for good.
//
// Exported because the capture screens count progress with it too (FR-INS-065).
// A second predicate there would let the driver read "10 of 10 done" off one
// definition while completeness_pct was computed from another — so this is the
// draft-shaped adapter over treadsRead (warnings.ts), never a second rule.
export function isCaptured(position: DraftPosition): boolean {
  return treadsRead(position.treads);
}

// The positions a submit would actually carry, keyed for the completeness
// figures the driver sees. By cell, not by position id: on a rig the same
// position id occurs once per member unit of the same configuration, and a set
// of bare ids would report two units as one (draft.cellKey).
export function capturedCells(draft: Draft): Set<string> {
  return new Set(
    Object.values(draft.positions)
      .filter(isCaptured)
      .map((p) => cellKey(p.vehicleId, p.positionId)),
  );
}

export function toSubmitPayload(draft: Draft, meta: SubmitMeta): SubmitPayload {
  const captured = Object.values(draft.positions).filter(isCaptured);

  const readings: SubmitReading[] = captured
    // Object key order is an implementation detail of how the driver happened
    // to walk the vehicle; the payload should not vary with it. The unit breaks
    // the tie, which is what makes the comparator total: two member units of
    // the same axle configuration carry the SAME position ids, so comparing
    // those alone returns 0 for every such couple, and a stable sort settles a
    // tie by insertion order — which is the walk order this is here to remove.
    .sort(
      (a, b) =>
        a.positionId.localeCompare(b.positionId, undefined, { numeric: true }) ||
        a.vehicleId.localeCompare(b.vehicleId),
    )
    .map((p) => ({
      // FR-INS-061 / BR-VEH-003: the unit that owns the position, and its own
      // position id. The 1..26 a driver sees on a rig is computed for the
      // diagram and never leaves the display layer.
      vehicle_id: p.vehicleId,
      position_id: p.positionId,
      // FR-INS-026/027 with FR-OFF-016: what the driver physically saw. The
      // server accepts it and records a discrepancy rather than refusing.
      tyre_id: p.tyreId,
      pressure_kpa: p.pressureKpa,
      pressure_temperature: p.pressureTemperature,
      damage_flag: p.damageFlag,
      note: p.note,
      // FR-INS-029a: entry order, left to right in the plan view. Never
      // sorted, never reversed — the server maps ordinal to
      // OUTER/CENTRE/INNER by the position's side. No governing value is sent
      // (CR-011, DR-017); the trigger derives it.
      treads: p.treads.filter((t): t is number => t !== null),
      granularity_mm: meta.granularityMm,
      seconds: p.seconds,
      warnings: p.warnings.map(wire),
    }));

  return {
    client_uuid: draft.clientUuid,
    vehicle_id: draft.vehicleId,
    combination_id: draft.combinationId,
    observed_member_vehicle_ids: draft.observedMemberVehicleIds,
    task_id: draft.taskId,
    started_at: draft.startedAt,
    submitted_at: meta.submittedAt,
    odometer_km: draft.odometerKm,
    duration_seconds: durationSeconds(draft.startedAt, meta.submittedAt),
    // Clamped rather than trusted. A draft survives a restart (FR-OFF-006) but
    // totalPositions comes from a context fetched after it, so a rig that has
    // since lost a member unit gives readings > totalPositions — and >100
    // fails the column's CHECK, which is a 422 the outbox never retries.
    completeness_pct:
      meta.totalPositions <= 0
        ? 0
        : Math.min(100, Math.round((readings.length / meta.totalPositions) * 100)),
    comment: draft.comment,
    defect_report: draft.defectReport,
    device_id: meta.deviceId,
    app_version: meta.appVersion,
    readings,
    warnings: draft.warnings.map(wire),
  };
}
