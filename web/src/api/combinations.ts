import { apiGet, apiPost } from "./client";
import type { UnitKind } from "./admin";

// Wire shapes of the rig surface (api/internal/httpapi/combinations.go — D3).
// The motive unit is always member sequence 1 with a null descriptor (U7),
// mirrored here rather than special-cased: the server enforces the order,
// this module only carries what it sends.
export interface RigMember {
  vehicleId: string;
  fleetNumber: string;
  sequence: number;
  descriptor: string | null;
  unitKind: UnitKind | null;
}

export interface Rig {
  id: string;
  motiveVehicleId: string;
  motiveFleetNumber: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  members: RigMember[];
}

export interface NewRig {
  motiveVehicleId: string;
  towed: { vehicleId: string; descriptor?: string }[];
  // Omitted means the tenant's today, resolved server-side by
  // app.tenant_day_instant — a browser-computed day is a day out for any
  // controller not sitting in the tenant's zone (rule 6, lessons 2026-09-03).
  effectiveOn?: string;
}

// fetchRigs is the Rigs screen's register read (D3): open first, then most
// recently started. ?open=true narrows to the open ones; the default is
// everything, since an ended rig is history a controller still needs.
export function fetchRigs(opts?: { open?: boolean }): Promise<Rig[]> {
  const qs = opts?.open ? "?open=true" : "";
  return apiGet<Rig[]>(`/api/combinations${qs}`);
}

// createRig is FR-VEH-030's write. What may be coupled to what is
// app.create_combination's alone (000037); this only carries the request and
// unwraps the rig it answers with.
export function createRig(body: NewRig): Promise<Rig> {
  return apiPost<Rig>("/api/combinations", body);
}

// endRig closes a rig (D4), answering with it rather than 204: the end
// instant is resolved in the tenant's own zone server-side, and the screen
// has nowhere else to read it.
export function endRig(rigId: string, body: { endedOn?: string }): Promise<Rig> {
  return apiPost<Rig>(`/api/combinations/${rigId}/end`, body);
}
