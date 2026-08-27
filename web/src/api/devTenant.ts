// DEV ONLY tenant selection, mirroring the API's dev actor resolver: the
// real tenant arrives with the IdP integration (TYRE-2), and the API ignores
// X-Tenant-ID and X-User-ID unless APP_DEV_TENANT_HEADER=1. Guarded by
// import.meta.env.DEV so a production bundle cannot send a chosen tenant or
// actor even by mistake.
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
  return import.meta.env.VITE_DEV_TENANT_ID ?? null;
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
  { id: "33333333-3333-3333-3333-333333333333", name: "Sandbox Fleet" },
] as const;

const ACTOR_STORAGE_KEY = "tyre.dev.user-id";

export function getDevActorId(): string | null {
  if (!import.meta.env.DEV) return null;
  try {
    const stored = window.localStorage.getItem(ACTOR_STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // Storage can be unavailable (private mode); the env default still applies.
  }
  return import.meta.env.VITE_DEV_USER_ID ?? null;
}

export function setDevActorId(userId: string): void {
  window.localStorage.setItem(ACTOR_STORAGE_KEY, userId);
}

export function clearDevActorId(): void {
  window.localStorage.removeItem(ACTOR_STORAGE_KEY);
}

// The seeded users (db/seeds/gen_seed_fixture.py). Ids are md5-derived so the
// fixture is reproducible; a user list endpoint would be gated on ManageUsers
// and is not what the dev switcher wants anyway.
export const DEV_ACTORS = [
  {
    id: "b85aef08-6081-80db-9d4d-dad38ae40545",
    name: "Melusi (driver, Johannesburg)",
    tenant: "11111111-1111-1111-1111-111111111111",
  },
  {
    id: "e4443562-7359-f4c3-de71-b538cdefdc14",
    name: "Sipho (driver, no depot)",
    tenant: "11111111-1111-1111-1111-111111111111",
  },
  {
    id: "14fc2c61-398c-3508-084e-d61e615e695e",
    name: "Nomsa (controller)",
    tenant: "11111111-1111-1111-1111-111111111111",
  },
  {
    id: "e00cf25a-d426-83b3-df67-8c61f42c6bda",
    name: "Pieter (org admin)",
    tenant: "11111111-1111-1111-1111-111111111111",
  },
  {
    id: "d95784fa-a659-7a02-53e4-83e500ced3ee",
    name: "Thabo (driver, Second Fleet)",
    tenant: "22222222-2222-2222-2222-222222222222",
  },
  // Sandbox Fleet carries no acceptance data, so it is the tenant to type into
  // when exploring. Anything entered against BAC has to be unpicked before the
  // pilot goes live; anything entered here is discarded by the next db-reset.
  {
    id: "40f019ce-192e-92d1-5b15-2eb7b65369df",
    name: "Sandbox Driver",
    tenant: "33333333-3333-3333-3333-333333333333",
  },
  {
    id: "c8b320df-8f90-ce76-e180-9d35ea293a9c",
    name: "Sandbox Controller",
    tenant: "33333333-3333-3333-3333-333333333333",
  },
  {
    id: "96b10943-acb4-c3d7-e8cd-3e1fb52e067e",
    name: "Sandbox Admin",
    tenant: "33333333-3333-3333-3333-333333333333",
  },
] as const;
