// The session the API sees (ADR-0016, U102). The library's stored user is
// the one copy of the tokens; this store decides when to renew and which
// driver a stored session may serve (U104).

import { ApiError } from "./apiError";
import { bounded } from "./deadline";
import { getDevActorId } from "./devTenant";
import { discardUser, renew, storedSession, type Tokens } from "../auth/oidc";

// The last driver whose sign-in passed the U104 compare. Queued inspections
// are stamped from it, and only the redirect callback writes it, so a 401
// leaves it alone and only signOut() clears it (TYRE-471 spec, The session).
export const SUBJECT_KEY = "tyre.auth.subject";
// The tenant GET /api/me proved, read for the branding cache key at first
// paint (b9 spec, Cached state). Every sign-in and signOut() remove it
// (TYRE-471 spec, The session).
export const TENANT_KEY = "tyre.auth.tenant";
export const BRANDING_PREFIX = "tyre.branding.";
// One-shot: written before the U104 undo signs someone out, read and cleared
// by the sign-in screen when the end-session redirect comes back.
export const OTHER_DRIVER_KEY = "tyre.auth.other-driver";

// A phone signed in before TYRE-471 still holds this key, with an access
// token and the driver's oid, and nothing else would remove it (U102;
// TYRE-471 spec, The old key). Nothing reads it.
function forgetOldCopy(): void {
  try {
    window.localStorage.removeItem("tyre.auth.mirror");
  } catch {
    // Unreadable storage holds nothing to remove.
  }
}
forgetOldCopy();

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

// Called on every successful GET /api/me (me.ts), with the last-known subject
// read before that call. An answer that lands once a sign-out or another
// tab's sign-in has changed it is the driver before's, so it writes nothing
// (TYRE-471 spec, The session).
export function rememberTenant(tenantId: string, sentUnder: string | null): void {
  if (sentUnder === null || lastKnownSubject() !== sentUnder) return;
  try {
    window.localStorage.setItem(TENANT_KEY, tenantId);
  } catch {
    // A full store costs only the branding cache key, so a successful
    // /api/me does not fail on it.
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

// Renewed first when this close to expiry, so none expires in flight
// (TYRE-471 spec, Expiry).
const EXPIRY_SKEW_MS = 60_000;
// A 401 on a token obtained this recently means the API refuses every valid
// token (a wrong AUTH_AUDIENCE, AUTH_CLIENT_ID or scope). Renewing cannot
// help, so the store stops until a reload (TYRE-471 spec, A fresh token
// refused).
const FRESH_MS = 60_000;

let latched = false;
let renewing: Promise<Tokens | null> | null = null;
let lapsed = false;
const lapseListeners = new Set<() => void>();
// The two tokens the store compares against and never sends: the last one a
// renewal or sign-in in this page obtained, and the last one the API refused
// (TYRE-471 spec, Sending).
let obtained: { accessToken: string; at: number } | null = null;
let refusedToken: string | null = null;

// Screens word this themselves (AccessScreen); the message is diagnostic.
export function authUnavailable(): ApiError {
  return new ApiError(503, "sign-in is unavailable", "auth_unavailable");
}

// True once a fresh token was refused (TYRE-471 spec, A fresh token refused).
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

// A renewal and a sign-in (callback.ts) record their token, so a 401 on it
// within FRESH_MS latches (TYRE-471 spec, A fresh token refused). A token
// just obtained is not the one refused, even when the provider issues the
// same string again.
export function recordObtained(accessToken: string): void {
  obtained = { accessToken, at: Date.now() };
  if (refusedToken === accessToken) refusedToken = null;
}

// Sign-out's local clear (TYRE-471 spec, Signing out). The memory goes too,
// so a page that a rejected sign-out or a back-forward restore leaves in
// place compares nothing against the last driver's tokens.
export function clearSession(): void {
  obtained = null;
  refusedToken = null;
  forgetOldCopy();
  window.localStorage.removeItem(SUBJECT_KEY);
  window.localStorage.removeItem(TENANT_KEY);
}

function setLapsed(value: boolean): void {
  if (lapsed === value) return;
  lapsed = value;
  lapseListeners.forEach((listener) => listener());
}

type Renewed = Tokens | null;

// U111 B: only the redirect callback changes the last-known subject, so a
// renewal for anyone else, or one that settles after a sign-out cleared it,
// is a lapse. The removal holds only while the stored user carries this
// renewal's token, so it never takes a later sign-in's (TYRE-471 spec,
// Renewal).
async function sameDriver(tokens: Renewed): Promise<Renewed> {
  if (tokens === null || tokens.subject === lastKnownSubject()) return tokens;
  try {
    await discardUser(tokens.accessToken);
  } catch {
    // Best effort.
  }
  return null;
}

function obtainedNow(tokens: Renewed): Renewed {
  if (tokens !== null) recordObtained(tokens.accessToken);
  return tokens;
}

// One renewal at a time, abandoned at its bound so the next call starts a
// new one (U199). The abandoned one runs on in the library, and its late
// settle removes only what it stored (TYRE-471 spec, Renewal).
function renewOnce(): Promise<Renewed> {
  renewing ??= bounded(renew().then(sameDriver).then(obtainedNow), "sign-in renewal").finally(
    () => {
      renewing = null;
    },
  );
  return renewing;
}

export async function credential(): Promise<{ accessToken: string; subject: string }> {
  // Checked first, since a build without VITE_AUTH_* cannot sign anyone in.
  if (latched || !authConfigured()) throw authUnavailable();
  const stored = await storedSession();
  const subject = lastKnownSubject();
  // A user whose oid is not the last-known subject never serves a call. It
  // is renewed, not removed here, because the library stores a sign-in's
  // user before the callback writes its subject (TYRE-471 spec, Which stored
  // user serves a call).
  const usable =
    stored !== null &&
    stored.subject === subject &&
    stored.accessToken !== refusedToken &&
    stored.expiresAt - EXPIRY_SKEW_MS > Date.now();
  // Every sign-in writes the last-known subject or does not finish, so
  // without one there is no session to renew (TYRE-471 spec, Renewal).
  const current = usable ? stored : subject === null ? null : await renewOnce();
  // Another tab's sign-in stores a user this tab reads, which ends this
  // tab's lapse too.
  setLapsed(current === null);
  if (current === null) throw new ApiError(401, "signed out", "signed_out");
  return { accessToken: current.accessToken, subject: current.subject };
}

// U104: who a queued inspection is stamped with and sent under.
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

// A reload forgets the refused mark, and the gate's GET /api/me is not
// retried on a 401, so the library's user is renewed at once rather than on
// the next call (TYRE-471 spec, Sending). Only while it still holds that
// token for the last-known subject, so a slow 401 for an older token starts
// nothing. A failure here reaches no caller; the next call meets it.
async function renewRefused(accessToken: string): Promise<void> {
  const stored = await storedSession();
  if (stored?.accessToken === accessToken && stored.subject === lastKnownSubject()) {
    await renewOnce();
  }
}

// send() calls this on a 401 from the API. True when this refusal, or an
// earlier one, latched the store; every call then answers 503 without
// touching the API. Otherwise only this token is marked, so a since-renewed
// token is left alone, and the library keeps its user, whose refresh token
// renews it (TYRE-471 spec, Sending).
export function refused(accessToken: string): boolean {
  if (latched) return true;
  // A clock corrected backwards leaves the obtained time in the future,
  // which is not "earlier" (TYRE-471 spec, A fresh token refused).
  const age = obtained?.accessToken === accessToken ? Date.now() - obtained.at : -1;
  if (age >= 0 && age < FRESH_MS) {
    console.error("API refused a fresh token (ADR-0016)");
    latched = true;
    return true;
  }
  refusedToken = accessToken;
  void renewRefused(accessToken).catch(() => undefined);
  return false;
}
