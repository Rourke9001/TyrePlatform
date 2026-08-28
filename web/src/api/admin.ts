import { apiGet, apiPost } from "./client";

// Wire shapes of the admin surface (api/internal/httpapi/admin.go). Each
// mirrors the server's projection exactly, so a screen that just created a
// unit holds the same shape it would have read from the list.

export interface AxleConfiguration {
  id: string;
  code: string;
  name: string;
  version: number;
  axleCount: number;
}

// Mirrors app.unit_kind. A union rather than string: the server refuses an
// unknown kind, and a form that can express one is a form that can send a
// request it knows will fail.
export type UnitKind = "HORSE" | "TRAILER" | "RIGID" | "LIGHT";

export interface NewUnit {
  fleetNumber: string;
  registration?: string;
  description?: string;
  configurationId: string;
  unitKind: UnitKind;
  homeDepotId?: string;
}

export interface CreatedUnit {
  id: string;
  fleetNumber: string;
  registration: string | null;
}

// PLATFORM_ADMIN is absent deliberately: it is not creatable through a tenant
// surface (ADR-0011, ADR-0013), and a picker that offers it offers a refusal.
export type TenantRole = "DRIVER" | "TECHNICIAN" | "CONTROLLER" | "DEPOT_MANAGER" | "ORG_ADMIN";

export interface NewUser {
  email: string;
  displayName: string;
  staffNumber?: string;
  role: TenantRole;
}

export interface CreatedUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  staffNumber: string | null;
  active: boolean;
}

export interface NewAssignment {
  userId: string;
  fromDate: string;
}

export interface Assignment {
  id: string;
  vehicleId: string;
  userId: string;
  fromDate: string;
}

export function fetchAxleConfigurations(): Promise<AxleConfiguration[]> {
  return apiGet<AxleConfiguration[]>("/api/axle-configurations");
}

export function createUnit(body: NewUnit): Promise<CreatedUnit> {
  return apiPost<CreatedUnit>("/api/vehicles", body);
}

export function createUser(body: NewUser): Promise<CreatedUser> {
  return apiPost<CreatedUser>("/api/users", body);
}

// The assignment hangs off the unit because it is the unit's relation, and a
// path that says so needs no body field to disambiguate it.
export function assignDriver(vehicleId: string, body: NewAssignment): Promise<Assignment> {
  return apiPost<Assignment>(`/api/vehicles/${vehicleId}/drivers`, body);
}
