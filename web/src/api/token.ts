// The session the API sees (ADR-0016, U102). The entry reads the access
// token from a mirror in its own localStorage key and never reads the
// sign-in library's storage format, so the library loads only when a
// renewal, a sign-in or a sign-out needs it.

import { ApiError } from "./apiError";
import { getDevActorId } from "./devTenant";
import { suppressReloadWhile } from "../shell/chunkReload";
import type * as AuthChunk from "../auth/oidc";

export const MIRROR_KEY = "tyre.auth.mirror";
// The last driver who signed in on this phone. Held inspections are stamped
// from it (U104), so only signOut() clears it. A 401 clears the mirror and
// leaves this alone.
export const SUBJECT_KEY = "tyre.auth.subject";
export const BRANDING_PREFIX = "tyre.branding.";
// One-shot: written before the U104 undo signs someone out, read and cleared
// by the sign-in screen when the end-session redirect comes back.
export const OTHER_DRIVER_KEY = "tyre.auth.other-driver";

export interface Mirror {
  accessToken: string;
  // Epoch milliseconds, as Date.now() reads.
  expiresAt: number;
  obtainedAt: number;
  // The Entra oid from the ID token (ADR-0016).
  subject: string;
  // The tenant RLS proved, from GET /api/me; null until that first answers.
  tenantId: string | null;
}

// The three fields a call depends on. The store sits in the capture entry
// (under a kilobyte gzipped, spec section 4), so the guard checks no more.
function isMirror(value: unknown): value is Mirror {
  const m = value as Partial<Mirror> | null;
  return (
    typeof m?.accessToken === "string" &&
    typeof m.subject === "string" &&
    typeof m.expiresAt === "number"
  );
}

export function readMirror(): Mirror | null {
  try {
    const raw = window.localStorage.getItem(MIRROR_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isMirror(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeMirror(mirror: Mirror): void {
  window.localStorage.setItem(MIRROR_KEY, JSON.stringify(mirror));
}

export function clearMirror(): void {
  try {
    window.localStorage.removeItem(MIRROR_KEY);
  } catch {
    // Unreadable storage holds no mirror to clear.
  }
}

export function lastKnownSubject(): string | null {
  try {
    return window.localStorage.getItem(SUBJECT_KEY);
  } catch {
    return null;
  }
}

export function rememberSubject(subject: string): void {
  window.localStorage.setItem(SUBJECT_KEY, subject);
}

// Called on every successful GET /api/me (me.ts). A full store costs only the
// branding cache key, so it must not turn that success into a failure.
export function rememberTenant(tenantId: string): void {
  const mirror = readMirror();
  if (mirror === null || mirror.tenantId === tenantId) return;
  try {
    writeMirror({ ...mirror, tenantId });
  } catch {
    // Best effort.
  }
}

// A production build has only the bearer path. Under vite dev and vitest the
// dev headers stay the default, so the test files that stub fetch and every
// e2e project but auth keep working; "bearer" opts a DEV session in.
export function bearerMode(): boolean {
  if (import.meta.env.DEV) {
    try {
      return window.localStorage.getItem("tyre.dev.auth") === "bearer";
    } catch {
      return false;
    }
  }
  return true;
}

// Stage 1 builds carry no VITE_AUTH_* values (ADR-0016), and a build without
// them cannot sign anyone in. That is "unavailable", not "signed out". Each
// read is written in full so the build folds it to a constant.
export function authConfigured(): boolean {
  return Boolean(
    import.meta.env.VITE_AUTH_AUTHORITY &&
    import.meta.env.VITE_AUTH_CLIENT_ID &&
    import.meta.env.VITE_AUTH_API_SCOPE,
  );
}

// The one dynamic import of the sign-in library (ADR-0016). A failed import
// is a network failure the outbox retries, never a reload (chunkReload.ts).
export function authChunk(): Promise<typeof AuthChunk> {
  return suppressReloadWhile(import("../auth/oidc"));
}

export interface Sender {
  accessToken: string | null;
  subject: string | null;
}

// Renewed first when this close to expiry, so none expires in flight (spec
// section 4, Expiry).
const EXPIRY_SKEW_MS = 60_000;
// A 401 on a token obtained this recently means the API refuses every valid
// token (a wrong AUTH_AUDIENCE, AUTH_CLIENT_ID or scope). Renewing cannot
// help, so the store stops until a reload (spec section 4, A fresh token
// refused).
const FRESH_MS = 60_000;

let latched = false;
// The last renewed token, kept beside the mirror, because a blocked store
// cannot hold it and the latch and the renewal count both depend on it.
let held: Mirror | null = null;
let renewing: Promise<Mirror | null> | null = null;
let lapsed = false;
const lapseListeners = new Set<() => void>();

// Screens word this themselves (AccessScreen); the message is diagnostic.
export function authUnavailable(): ApiError {
  return new ApiError(503, "sign-in is unavailable", "auth_unavailable");
}

// True once a fresh token was refused (spec section 4, A fresh token refused).
export function isLatched(): boolean {
  return latched;
}

export function sessionLapsed(): boolean {
  return lapsed;
}

export function onLapse(listener: () => void): () => void {
  lapseListeners.add(listener);
  return () => {
    lapseListeners.delete(listener);
  };
}

// Sign-out's local clear (spec section 4, Signing out). `held` lives here, so
// the page a rejected sign-out or a back-forward restore leaves in place
// cannot answer with the old token.
export function clearSession(): void {
  held = null;
  window.localStorage.removeItem(MIRROR_KEY);
  window.localStorage.removeItem(SUBJECT_KEY);
}

function setLapsed(value: boolean): void {
  if (lapsed === value) return;
  lapsed = value;
  lapseListeners.forEach((listener) => listener());
}

// The chunk never writes the mirror (spec section 4), so the store does. A
// blocked store must not fail a renewed token, so only then is `held` kept;
// a working store stays the one source, which another tab's sign-out clears.
function mirrorRenewed(tokens: Awaited<ReturnType<typeof AuthChunk.renew>>): Mirror | null {
  if (tokens === null) {
    held = null;
    clearMirror();
    return null;
  }
  const previous = readMirror();
  const mirror: Mirror = {
    ...tokens,
    obtainedAt: Date.now(),
    tenantId: previous?.subject === tokens.subject ? previous.tenantId : null,
  };
  try {
    writeMirror(mirror);
    rememberSubject(mirror.subject);
    held = null;
  } catch {
    held = mirror;
  }
  return mirror;
}

// One renewal in flight, because refresh tokens may rotate and two concurrent
// renewals would spend the same one twice.
function renewOnce(): Promise<Mirror | null> {
  renewing ??= authChunk()
    .then((auth) => auth.renew())
    .then(mirrorRenewed)
    .finally(() => {
      renewing = null;
    });
  return renewing;
}

export async function credential(): Promise<{ accessToken: string; subject: string }> {
  // Checked before the import, since a build without VITE_AUTH_* cannot sign
  // anyone in.
  if (latched || !authConfigured()) throw authUnavailable();
  const usable = (m: Mirror | null) => m !== null && m.expiresAt - EXPIRY_SKEW_MS > Date.now();
  const mirror = readMirror();
  const current = usable(mirror) ? mirror : usable(held) ? held : await renewOnce();
  // Another tab's sign-in writes the shared mirror, which ends this tab's
  // lapse too.
  setLapsed(current === null);
  if (current === null) throw new ApiError(401, "signed out", "signed_out");
  return { accessToken: current.accessToken, subject: current.subject };
}

// U104: who a held inspection is stamped with and sent under. On the DEV
// header path the dev actor stands in (bearerMode() says when).
export function sender(): Promise<Sender> {
  if (import.meta.env.DEV && !bearerMode()) {
    return Promise.resolve({ accessToken: null, subject: getDevActorId() });
  }
  return credential();
}

export function stampSubject(): string | null {
  if (import.meta.env.DEV && !bearerMode()) return getDevActorId();
  return lastKnownSubject();
}

// send() calls this on a 401 from the API. True when this refusal, or an earlier
// one, latched the store. Every call then answers 503 without touching the API.
export function refused(accessToken: string): boolean {
  if (latched) return true;
  const mirror = readMirror();
  const recent = [mirror, held].find(
    (m) => m?.accessToken === accessToken && Date.now() - m.obtainedAt < FRESH_MS,
  );
  if (recent !== undefined) {
    console.error("API refused a fresh token (ADR-0016)");
    latched = true;
    return true;
  }
  // A slow 401 for an earlier token must not clear a session that has since
  // renewed.
  if (held?.accessToken === accessToken) held = null;
  if (mirror?.accessToken === accessToken) clearMirror();
  return false;
}
