// The session the API sees (ADR-0016, U102). The entry reads the access
// token from a mirror in its own localStorage key and never reads the
// sign-in library's storage format, so the library loads only when a
// renewal, a sign-in or a sign-out needs it.

export const MIRROR_KEY = "tyre.auth.mirror";
// The last driver who signed in on this phone. Held inspections are stamped
// from it (U104), so only signOut() clears it: a 401 clears the mirror and
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
    // The next /api/me tries again.
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
// them cannot sign anyone in: that is "unavailable", not "signed out". Each
// read is written in full so the build folds it to a constant.
export function authConfigured(): boolean {
  return Boolean(
    import.meta.env.VITE_AUTH_AUTHORITY &&
    import.meta.env.VITE_AUTH_CLIENT_ID &&
    import.meta.env.VITE_AUTH_API_SCOPE,
  );
}
