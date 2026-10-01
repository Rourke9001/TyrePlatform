// Transport only: identity attribution and error shaping. Anything smarter
// than a fetch belongs server-side (docs/architecture.md).

import { getDevActorId, getDevTenantId } from "./devTenant";
import { ApiError } from "./apiError";
import { authUnavailable, refused, sender, type Sender } from "./token";

export { ApiError } from "./apiError";

// The one name the bearer travels under here, and one constant in Go
// (bearer.HeaderName). If Static Web Apps strips it on the linked backend,
// the fallback header changes in those two places only (ADR-0016, TYRE-51).
export const AUTH_HEADER = "Authorization";

// An unreadable body yields nulls, not a throw (ADR-0012): failing to parse
// a refusal must not lose the inspection the outbox is holding. Both fields
// come from one parse; a Response body reads once.
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

// One implementation of identity attribution, refusal shaping and 204
// handling; apiGet/Post/Patch delegate here so they cannot drift apart.
async function send<T>(method: string, path: string, body?: unknown, as?: Sender): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const who = as ?? (await sender());
  if (who.accessToken !== null) {
    headers[AUTH_HEADER] = `Bearer ${who.accessToken}`;
  } else if (import.meta.env.DEV) {
    // Inside the DEV guard so a production build names neither header
    // (scripts/check-dist-dev-strings.mjs holds it, TYRE-317).
    const devTenant = getDevTenantId();
    const devActor = getDevActorId();
    if (devTenant) headers["X-Tenant-ID"] = devTenant;
    if (devActor) headers["X-User-ID"] = devActor;
  }

  const res = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    if (res.status === 401 && who.accessToken !== null && refused(who.accessToken)) {
      throw authUnavailable();
    }
    const { code, message } = await refusal(res);
    throw new ApiError(res.status, message ?? `${method} ${path} failed: ${res.status}`, code);
  }
  // A 204 from any verb carries no body, by spec, and res.json() rejects on
  // an empty stream. A bare parse here would turn a successful call into a
  // thrown SyntaxError indistinguishable from a transport failure.
  if (res.status === 204) {
    return undefined as unknown as T;
  }
  return res.json() as Promise<T>;
}

export function apiGet<T>(path: string): Promise<T> {
  return send<T>("GET", path);
}

export function apiPost<T>(path: string, body: unknown): Promise<T> {
  return send<T>("POST", path, body);
}

// U104: the outbox sends under the credential it compared the entry's stamp
// against, never one read again after the compare.
export function apiPostAs<T>(path: string, body: unknown, as: Sender): Promise<T> {
  return send<T>("POST", path, body, as);
}

// PATCH carries the unit's descriptive fields, ones no SQL rule governs
// (D5); POSTs on this surface call a function because one does (ADR-0013
// decision 1). The distinction is server-side.
export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return send<T>("PATCH", path, body);
}
