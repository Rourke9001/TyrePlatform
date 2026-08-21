// Transport only: tenant attribution and error shaping. Anything smarter
// than a fetch belongs server-side (docs/architecture.md).

import { getDevTenantId } from "./devTenant";

export async function apiGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const devTenant = getDevTenantId();
  if (devTenant) headers["X-Tenant-ID"] = devTenant;

  const res = await fetch(path, { headers });
  if (!res.ok) {
    throw new Error(`GET ${path} failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}
