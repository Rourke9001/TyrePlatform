import { apiGet, apiPost } from "./client";
import type { UnitKind, Vehicle } from "./vehicles";

export type { UnitKind };

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

export interface NewUnit {
  fleetNumber: string;
  registration?: string;
  description?: string;
  configurationId: string;
  unitKind: UnitKind;
  homeDepotId?: string;
}

// The create answers GET /api/vehicles's own row (ADR-0013 decision 9), so a
// caller holds what it just wrote without a second round trip.
export type CreatedUnit = Vehicle;

// PLATFORM_ADMIN is absent deliberately: it is not creatable through a tenant
// surface (ADR-0011, ADR-0013), and a picker that offers it offers a refusal.
export type TenantRole = "DRIVER" | "TECHNICIAN" | "CONTROLLER" | "DEPOT_MANAGER" | "ORG_ADMIN";

export interface NewUser {
  email: string;
  displayName: string;
  staffNumber?: string;
  role: TenantRole;
  // D10: the admin's answer to "this address belongs to a deactivated user".
  // Absent is a plain create; the server refuses with email_inactive until it
  // is set, so this can never reactivate somebody silently.
  reactivate?: boolean;
}

export interface CreatedUser {
  id: string;
  email: string;
  displayName: string;
  role: string;
  staffNumber: string | null;
  active: boolean;
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
