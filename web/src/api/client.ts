// Transport only: identity attribution and error shaping. Anything smarter
// than a fetch belongs server-side (docs/architecture.md).

import { getDevActorId, getDevTenantId } from "./devTenant";
import { ApiError } from "./apiError";
import { apiUrl } from "./runtimeConfig";
import { deadline } from "./deadline";
import { authUnavailable, isLatched, refused, sender, type Sender } from "./token";

export { ApiError } from "./apiError";

// The one name the bearer travels under here, and one constant in Go
// (bearer.HeaderName), so the two sides cannot disagree (ADR-0016).
export const AUTH_HEADER = "Authorization";

// A refusal's text that arrived but carries no envelope (a proxy's HTML page,
// a body cut short) yields nulls, so the status alone decides. Both fields
// come from one parse.
function refusal(text: string): { code: string | null; message: string | null } {
  const none = { code: null, message: null };
  try {
    const body: unknown = JSON.parse(text);
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
  // A latch set after the caller took its credential still stops the send.
  if (as !== undefined && isLatched()) throw authUnavailable();
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

  // TYRE-389: bounded from here, after the credential, since a renewal
  // carries its own bound (token.ts).
  const bound = deadline();
  try {
    const res = await bound.within(
      fetch(apiUrl(path), {
        method,
        headers,
        signal: bound.signal,
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    if (!res.ok) {
      if (res.status === 401) {
        // Nothing reads a 401's body (failureOf, classify), so it is not
        // waited for, and a lost one cannot delay "Sign in to send". The
        // null code below is how fetchMe tells the API's 401 from the
        // store's (me.ts). Cancelled, or a stalled one holds its connection
        // past the bound.
        void res.body?.cancel().catch(() => undefined);
        if (who.accessToken !== null && refused(who.accessToken)) throw authUnavailable();
        throw new ApiError(401, `${method} ${path} failed: 401`, null);
      }
      // A refusal's code can make it retryable (outbox.ts classify), so a
      // body that stalls or is lost in transit is offline, never the bare
      // status: the read stays outside refusal()'s catch.
      const { code, message } = refusal(await bound.within(res.text()));
      throw new ApiError(res.status, message ?? `${method} ${path} failed: ${res.status}`, code);
    }
    // A 204 from any verb carries no body, by spec, and res.json() rejects on
    // an empty stream. A bare parse here would turn a successful call into a
    // thrown SyntaxError indistinguishable from a transport failure.
    if (res.status === 204) {
      return undefined as unknown as T;
    }
    return await bound.within(res.json() as Promise<T>);
  } finally {
    bound.end();
  }
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
