import { apiGet } from "./client";

// Wire shape of GET /api/org/branding (TYRE-26). logoUrl stays null until
// logo serving arrives with RBAC; the wordmark render is the designed
// default, not a fallback state.
export interface Branding {
  displayName: string;
  primaryColor: string;
  logoUrl: string | null;
}

export function fetchBranding(): Promise<Branding> {
  return apiGet<Branding>("/api/org/branding");
}
