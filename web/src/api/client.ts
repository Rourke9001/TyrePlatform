// Transport only: identity attribution and error shaping. Anything smarter
// than a fetch belongs server-side (docs/architecture.md).

import { getDevActorId, getDevTenantId } from "./devTenant";

// The status is the outbox's decision (FR-OFF-012 vs FR-OFF-013); the code is
// the reason, which is what decides the sentence a driver reads. A 409 alone
// cannot separate FR-INS-038's duplicate window from any other conflict
// (ADR-0012).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// A proxy, a gateway or a browser-generated failure carries no envelope, so an
// absent or unreadable code is null rather than a throw: an error path that
// fails while reporting a failure loses the inspection the outbox is holding.
async function refusalCode(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (typeof body === "object" && body !== null && "code" in body) {
      return typeof body.code === "string" ? body.code : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function apiGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const devTenant = getDevTenantId();
  const devActor = getDevActorId();
  if (devTenant) headers["X-Tenant-ID"] = devTenant;
  if (devActor) headers["X-User-ID"] = devActor;

  const res = await fetch(path, { headers });
  if (!res.ok) {
    throw new ApiError(res.status, `GET ${path} failed: ${res.status}`, await refusalCode(res));
  }
  return res.json() as Promise<T>;
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const devTenant = getDevTenantId();
  const devActor = getDevActorId();
  if (devTenant) headers["X-Tenant-ID"] = devTenant;
  if (devActor) headers["X-User-ID"] = devActor;

  const res = await fetch(path, { method: "POST", headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new ApiError(res.status, `POST ${path} failed: ${res.status}`, await refusalCode(res));
  }
  return res.json() as Promise<T>;
}
