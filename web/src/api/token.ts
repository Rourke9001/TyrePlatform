// The session the API sees (ADR-0016, U102). The store reads the access
// token from a mirror in its own localStorage key and never reads the
// sign-in library's storage format.

import { ApiError } from "./apiError";
import { bounded } from "./deadline";
import { getDevActorId } from "./devTenant";
import { discardUser, renew, type Tokens } from "../auth/oidc";

export const MIRROR_KEY = "tyre.auth.mirror";
// The last driver who signed in on this phone. Held inspections are stamped
// from it (U104), so only signOut() clears it. A 401 clears the mirror and
// leaves this alone.
export const SUBJECT_KEY = "tyre.auth.subject";
// The tenant GET /api/me proved, read for the branding cache key at first
// paint (b9 spec, Cached state). Every sign-in and signOut() remove it
// (TYRE-471 spec, The session).
export const TENANT_KEY = "tyre.auth.tenant";
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

export function brandingTenant(): string | null {
  try {
    return window.localStorage.getItem(TENANT_KEY);
  } catch {
    return null;
  }
}

// Called on every successful GET /api/me (me.ts). An answer that lands
// after signOut() cleared the subject must not put the key back (TYRE-471
// spec, Signing out). A full store costs only the branding cache key, so it
// must not turn that success into a failure.
export function rememberTenant(tenantId: string): void {
  if (lastKnownSubject() === null) return;
  try {
    window.localStorage.setItem(TENANT_KEY, tenantId);
  } catch {
    // Best effort.
  }
}

// The redirect callback's step 2. It throws, so a sign-in whose tenant key
// cannot go does not finish (TYRE-471 spec, The redirect callback).
export function forgetTenant(): void {
  window.localStorage.removeItem(TENANT_KEY);
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

// The DEV header path, where the dev actor and tenant stand in. Led by
// import.meta.env.DEV so a production build folds every caller's branch away
// (scripts/check-dist-dev-strings.mjs, TYRE-317).
export function devHeaderPath(): boolean {
  return import.meta.env.DEV && !bearerMode();
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
  window.localStorage.removeItem(TENANT_KEY);
}

function setLapsed(value: boolean): void {
  if (lapsed === value) return;
  lapsed = value;
  lapseListeners.forEach((listener) => listener());
}

type Renewed = Tokens | null;

// oidc.ts never writes the mirror (spec section 4), so the store does. A
// blocked store must not fail a renewed token, so only then is `held` kept;
// a working store stays the one source, which another tab's sign-out clears.
function mirrorRenewed(tokens: Renewed): Mirror | null {
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
    held = null;
  } catch {
    held = mirror;
  }
  return mirror;
}

// U111 B: only the redirect callback changes the last-known subject, so a
// renewal for anyone else, or for a subject cleared while it ran, ends that
// session rather than adopting it.
async function sameDriver(tokens: Renewed): Promise<Renewed> {
  if (tokens === null || tokens.subject === lastKnownSubject()) return tokens;
  try {
    await discardUser(tokens.accessToken);
  } catch {
    // Best effort; mirrorRenewed clears the mirror either way.
  }
  return null;
}

// One renewal in flight until it settles, past the bound too, because
// refresh tokens may rotate and two concurrent renewals would spend the same
// one twice. A caller that joins a stuck one gets its rejection at once.
function renewOnce(): Promise<Mirror | null> {
  renewing ??= bounded(
    renew()
      .then(sameDriver)
      .then(mirrorRenewed)
      .finally(() => {
        renewing = null;
      }),
    "sign-in renewal",
  );
  return renewing;
}

export async function credential(): Promise<{ accessToken: string; subject: string }> {
  // Checked first, since a build without VITE_AUTH_* cannot sign anyone in.
  if (latched || !authConfigured()) throw authUnavailable();
  const usable = (m: Mirror | null) => m !== null && m.expiresAt - EXPIRY_SKEW_MS > Date.now();
  const mirror = readMirror();
  // Every sign-in writes the last-known subject or does not finish, so
  // without one there is no session to renew, and no refresh token a stray
  // library user holds is spent learning that (spec section 4, Renewal).
  const current = usable(mirror)
    ? mirror
    : usable(held)
      ? held
      : lastKnownSubject() === null
        ? null
        : await renewOnce();
  // Another tab's sign-in writes the shared mirror, which ends this tab's
  // lapse too.
  setLapsed(current === null);
  if (current === null) throw new ApiError(401, "signed out", "signed_out");
  return { accessToken: current.accessToken, subject: current.subject };
}

// U104: who a held inspection is stamped with and sent under.
export function sender(): Promise<Sender> {
  if (devHeaderPath()) {
    return Promise.resolve({ accessToken: null, subject: getDevActorId() });
  }
  return credential();
}

export function stampSubject(): string | null {
  if (devHeaderPath()) return getDevActorId();
  return lastKnownSubject();
}

// send() calls this on a 401 from the API. True when this refusal, or an earlier
// one, latched the store. Every call then answers 503 without touching the API.
export function refused(accessToken: string): boolean {
  if (latched) return true;
  const mirror = readMirror();
  // A clock corrected backwards leaves obtainedAt in the future, which is not
  // "earlier" (spec section 4, A fresh token refused).
  const fresh = (m: Mirror) => {
    const age = Date.now() - m.obtainedAt;
    return age >= 0 && age < FRESH_MS;
  };
  const recent = [mirror, held].find((m) => m?.accessToken === accessToken && fresh(m));
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
