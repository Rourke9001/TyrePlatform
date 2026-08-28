// Transport only: identity attribution and error shaping. Anything smarter
// than a fetch belongs server-side (docs/architecture.md).

import { getDevActorId, getDevTenantId } from "./devTenant";

// The status is the outbox's decision (FR-OFF-012 vs FR-OFF-013); the code is
// the reason, which is what decides the sentence a driver reads. A 409 alone
// cannot separate FR-INS-038's duplicate window from any other conflict
// (ADR-0012). The message is the envelope's own text when present (the server's
// words for rendering a screen refusal); otherwise a diagnostic to absorb an
// error path that failed while reporting an error (ADR-0013).
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

// The refusal envelope, or nothing (ADR-0012). A proxy, a gateway or a
// browser-generated failure carries none, so an unreadable body yields nulls
// rather than a throw: an error path that fails while reporting a failure
// loses the inspection the outbox is holding.
//
// Both fields come from one parse because a Response body can only be read
// once.
async function refusal(res: Response): Promise<{ code: string | null; message: string | null }> {
  const none = { code: null, message: null };
  try {
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return none;
    return {
      code: "code" in body && typeof body.code === "string" ? body.code : null,
      message: "message" in body && typeof body.message === "string" ? body.message : null,
    };
  } catch {
    return none;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  const devTenant = getDevTenantId();
  const devActor = getDevActorId();
  if (devTenant) headers["X-Tenant-ID"] = devTenant;
  if (devActor) headers["X-User-ID"] = devActor;

  const res = await fetch(path, { headers });
  if (!res.ok) {
    const { code, message } = await refusal(res);
    throw new ApiError(res.status, message ?? `GET ${path} failed: ${res.status}`, code);
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
    const { code, message } = await refusal(res);
    throw new ApiError(res.status, message ?? `POST ${path} failed: ${res.status}`, code);
  }
  return res.json() as Promise<T>;
}
