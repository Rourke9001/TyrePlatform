// DEV ONLY tenant selection, mirroring the API's X-Tenant-ID resolver: the
// real tenant arrives with the IdP integration (TYRE-2), and the API ignores
// the header unless APP_DEV_TENANT_HEADER=1. Guarded by import.meta.env.DEV
// so a production bundle cannot send a chosen tenant even by mistake.
//
// localStorage wins over the env default so the tenant switcher (TYRE-28)
// can flip tenants without a rebuild.

const STORAGE_KEY = "tyre.dev.tenant-id";

export function getDevTenantId(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // Storage can be unavailable (private mode); the env default still applies.
  }
  return (import.meta.env.VITE_DEV_TENANT_ID as string | undefined) ?? null;
}

export function setDevTenantId(tenantId: string): void {
  window.localStorage.setItem(STORAGE_KEY, tenantId);
}

export function clearDevTenantId(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

// The two seeded tenants (db/seeds/gen_seed_configurations.py). A tenant
// list endpoint would be a cross-tenant read and deliberately does not
// exist, so the dev switcher carries the seed constants itself.
export const DEV_TENANTS = [
  { id: "11111111-1111-1111-1111-111111111111", name: "BAC Transport" },
  { id: "22222222-2222-2222-2222-222222222222", name: "Second Fleet" },
] as const;
