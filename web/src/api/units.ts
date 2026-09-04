import { apiGet, apiPatch, apiPost } from "./client";

// Wire shapes of the unit and fitment surface (api/internal/httpapi/units.go,
// fitments.go — TYRE-92/93/94). Every nullable Go field is mirrored as
// `T | null`, never coerced to a default: registration and the rest are
// nullable columns (units.go's own comment), and a client that treated an
// absent value as "" would be inventing a fact the register never recorded.

// openFitmentJSON: a position's current occupant, no money field to gate
// (units.go's own comment on why there is no canSeeMoney branch here).
export interface OpenFitment {
  fitmentId: string;
  tyreId: string;
  displayCode: string;
  fittedAt: string;
  fittedOdometer: number | null;
  fittedTreadMm: string | null;
  mountOrientation: string;
  tyreStatus: string;
  retreadCount: number;
  sizeName: string | null;
  lastTreadMm: string | null;
}

// unitPositionJSON: side and slot are null for a spare, mirroring
// app.position's spare_has_no_geometry constraint (000001).
export interface UnitPosition {
  id: string;
  code: string;
  sequence: number;
  axleNumber: number | null;
  axleClass: string;
  side: string | null;
  slot: string | null;
  isSpare: boolean;
  fitment: OpenFitment | null;
}

// unitJSON: the GET /api/vehicles/{id} body, and the unit PATCH's response
// (D6) — one shape for both, so a screen that just edited a unit holds the
// same read it would get from re-fetching it.
export interface Unit {
  id: string;
  fleetNumber: string;
  registration: string | null;
  description: string | null;
  bodyType: string | null;
  unitDescriptor: string | null;
  unitKind: string | null;
  status: string;
  configurationId: string;
  configurationName: string;
  homeDepotId: string | null;
  operatingGroupId: string | null;
  tags: string[];
  hasHistory: boolean;
  removalReasons: string[];
  hasOdometer: boolean;
  positions: UnitPosition[];
}

// fitmentHistoryJSON: one row of GET /api/vehicles/{id}/fitments. distanceKm
// is nil whenever distanceSource is UNAVAILABLE — CR-012's pairing, kept
// intact here rather than collapsed into a single optional number.
export interface FitmentHistoryRow {
  fitmentId: string;
  tyreId: string;
  displayCode: string;
  positionCode: string;
  fittedAt: string;
  removedAt: string | null;
  fittedOdometer: number | null;
  removedOdometer: number | null;
  fittedTreadMm: string | null;
  removedTreadMm: string | null;
  removalReason: string | null;
  distanceKm: number | null;
  distanceSource: string;
  mountOrientation: string;
}

// fleetFitmentJSON: one row of GET /api/fitments?open=true, the Fitments
// screen. daysFitted arrives computed in the tenant's own civil calendar
// (rule 6) — never recomputed client-side from a browser clock.
export interface FleetFitment {
  fitmentId: string;
  vehicleId: string;
  fleetNumber: string;
  positionCode: string;
  tyreId: string;
  displayCode: string;
  fittedAt: string;
  daysFitted: number;
}

export interface Depot {
  id: string;
  name: string;
  type: string;
}

// fetchUnit is the manager-facing single-unit read (D6). Cross-tenant and
// missing ids are the same 404 by construction (RLS, ADR-0011); no narrowing
// happens here.
export function fetchUnit(id: string): Promise<Unit> {
  return apiGet<Unit>(`/api/vehicles/${id}`);
}

// fetchUnitFitments is FR-FIT's history read: every fitment the unit has
// ever carried, open and closed, most recent first — the server's own order.
export function fetchUnitFitments(id: string): Promise<FitmentHistoryRow[]> {
  return apiGet<FitmentHistoryRow[]>(`/api/vehicles/${id}/fitments`);
}

// fetchOpenFitments is the Fitments screen's fleet-wide read. open=true is
// always sent: listOpenFitments refuses any other value of the query
// parameter (units.go), so there is no unfiltered variant to expose here.
export function fetchOpenFitments(): Promise<FleetFitment[]> {
  return apiGet<FleetFitment[]>("/api/fitments?open=true");
}

// fetchDepots backs the dispatch and return forms' pickers. type is built
// only when given — an unrecognised value reaches the cast and comes back
// as invalid_submission (22P02; TYRE-128 decision 7), not narrowed a second
// time here.
export function fetchDepots(type?: string): Promise<Depot[]> {
  const qs = type ? `?type=${encodeURIComponent(type)}` : "";
  return apiGet<Depot[]>(`/api/depots${qs}`);
}

export interface NewFitment {
  tyreId: string;
  positionId: string;
  treadMm: string;
  mountOrientation: string;
  odometer?: number;
  occurredAt?: string;
  reason?: string;
}

export interface FitWarning {
  code: string;
  message: string;
}

export interface FitResult {
  fitmentId: string;
  warnings: FitWarning[];
}

// fitTyre is FR-FIT-001's write. Occupancy, the retread and dual-mate
// warnings and every other rule about what may be fitted are app.fit_tyre's
// alone (fitments.go's own comment) — this only carries the request and
// unwraps the result.
export function fitTyre(unitId: string, body: NewFitment): Promise<FitResult> {
  return apiPost<FitResult>(`/api/vehicles/${unitId}/fitments`, body);
}

export interface Removal {
  reason: string;
  treadMm: string;
  odometer?: number;
  occurredAt?: string;
  backdateReason?: string;
}

// removeFitment is FR-FIT-007's write, answering 204: a removal produces no
// projection a caller cannot already read from the unit it closed. Which
// reasons are valid is tenant configuration (rule 5, FR-FIT-008), forwarded
// verbatim by app.remove_tyre rather than checked here.
export function removeFitment(fitmentId: string, body: Removal): Promise<void> {
  return apiPost<void>(`/api/fitments/${fitmentId}/remove`, body);
}

export interface RotationMove {
  tyreId: string;
  toPositionId: string;
  treadMm: string;
}

export interface Rotation {
  moves: RotationMove[];
  odometer?: number;
  occurredAt?: string;
}

export interface RotationMoveResult {
  tyreId: string;
  fitmentId: string;
}

export interface RotationResult {
  moves: RotationMoveResult[];
}

// rotateTyres is FR-FIT-010's write: one set of moves within one unit,
// applied whole or not at all — the atomicity is app.rotate_tyres' own
// (fitments.go's own comment), not re-implemented here.
export function rotateTyres(unitId: string, body: Rotation): Promise<RotationResult> {
  return apiPost<RotationResult>(`/api/vehicles/${unitId}/rotations`, body);
}

export interface UnitPatch {
  fleetNumber?: string;
  registration?: string;
  description?: string;
  bodyType?: string;
  unitDescriptor?: string;
  homeDepotId?: string;
  operatingGroupId?: string;
  tags?: string[];
}

// patchUnit is FR-VEH-041's descriptive edit (D5): a key the caller omits
// leaves that column untouched server-side, which is what lets a form send
// only what someone actually changed rather than the whole unit back. "" means
// three different things by field — clear, no-op or refusal — all of it
// decided in patchUnitRequest's validate() (units.go), none re-implemented
// here.
export function patchUnit(id: string, body: UnitPatch): Promise<Unit> {
  return apiPatch<Unit>(`/api/vehicles/${id}`, body);
}

// setUnitStatus is FR-VEH-005/006's write, answering 204. Status is
// deliberately not one of UnitPatch's fields: which transitions are legal —
// DISPOSED is terminal, a disposal needs an empty unit and a stated reason —
// is app.set_vehicle_status's rule, not this client's (units.go's own
// comment).
export function setUnitStatus(
  id: string,
  body: { status: string; reason?: string },
): Promise<void> {
  return apiPost<void>(`/api/vehicles/${id}/status`, body);
}
