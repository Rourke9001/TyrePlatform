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

// The one implementation of identity attribution, refusal shaping and 204
// handling: apiGet, apiPost and apiPatch differ only in HTTP method and
// whether a body exists, so every verb below delegates here rather than
// carrying its own copy of headers/refusal/204 to drift from the others'.
async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const devTenant = getDevTenantId();
  const devActor = getDevActorId();
  if (devTenant) headers["X-Tenant-ID"] = devTenant;
  if (devActor) headers["X-User-ID"] = devActor;

  const res = await fetch(path, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const { code, message } = await refusal(res);
    throw new ApiError(res.status, message ?? `${method} ${path} failed: ${res.status}`, code);
  }
  // A 204 from any verb carries no body, by spec, and res.json() rejects on
  // an empty stream — a bare parse here would turn a successful call into a
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

// PATCH is the unit's descriptive edit (D5): the fields a plain UPDATE owns
// because no SQL rule governs them, distinct from the POSTs on this surface
// that call into a function precisely because one does (ADR-0013 decision
// 1). The distinction is server-side; this function only carries the verb.
export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return send<T>("PATCH", path, body);
}
