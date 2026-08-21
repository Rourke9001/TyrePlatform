import { apiGet } from "./client";

// Wire shape of GET /api/org/branding (TYRE-26). logoUrl is null until logo
// serving arrives with RBAC; AppShell's BrandMark holds the render rationale.
export interface Branding {
  displayName: string;
  primaryColor: string;
  logoUrl: string | null;
}

export function fetchBranding(): Promise<Branding> {
  return apiGet<Branding>("/api/org/branding");
}
