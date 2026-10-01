import {
  OTHER_DRIVER_KEY,
  authChunk,
  bearerMode,
  clearMirror,
  rememberSubject,
  writeMirror,
} from "../api/token";
import { flushOutbox, heldStamps } from "../capture/outbox";
import type { SignedIn } from "./oidc";

let didNotFinish = false;

// For the sign-in screen's one line (spec section 4, The redirect callback).
export function signInDidNotFinish(): boolean {
  return didNotFinish;
}

export function isRedirectCallback(url: URL): boolean {
  const q = url.searchParams;
  return url.pathname === "/" && q.has("state") && (q.has("code") || q.has("error"));
}

// Only the state id goes to the identity provider; returnTo stays in the
// local state store. The same-origin check is defence in depth for a value
// read back from storage. It tests the parsed path, because new URL() turns
// "/..//evil.test" into "//evil.test", which a browser reads as another host.
export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname.startsWith("//")) return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

// A failed stamp read is nothing held (heldStamps); attemptSend compares the
// stamp again before any send, so no wrong-driver send follows (U104).
async function othersHeld(subject: string): Promise<boolean> {
  return (await heldStamps()).some((stamp) => stamp !== subject);
}

// U104: sign the newcomer out through the full signOut(), marker first. A
// rejection (end-session metadata unreachable offline) still counts as signed
// out: oidc.ts signOut clears the entry's keys first, and the library's own
// removeUser runs before it navigates.
async function undoSignIn(): Promise<void> {
  try {
    window.sessionStorage.setItem(OTHER_DRIVER_KEY, "1");
  } catch {
    // Without the marker the screen shows its neutral count instead.
  }
  try {
    await (await authChunk()).signOut();
  } catch {
    // Signed out locally; see above.
  }
}

export type RedirectOutcome = "none" | "signed-in" | "failed" | "undone";

// Runs before the first render (main.tsx), so the U104 compare comes before
// anything calls the API as the person who just signed in (ADR-0016, U104).
export async function completeRedirect(): Promise<RedirectOutcome> {
  const url = new URL(window.location.href);
  if (!bearerMode() || !isRedirectCallback(url)) return "none";

  let signedIn: SignedIn;
  try {
    signedIn = await (await authChunk()).completeSignIn(url.href);
  } catch {
    didNotFinish = true;
    return "failed";
  } finally {
    // Success or not, so a reload cannot replay a spent code.
    window.history.replaceState(null, "", "/");
  }

  if (await othersHeld(signedIn.subject)) {
    await undoSignIn();
    return "undone";
  }

  try {
    writeMirror({
      accessToken: signedIn.accessToken,
      expiresAt: signedIn.expiresAt,
      obtainedAt: Date.now(),
      subject: signedIn.subject,
      tenantId: null,
    });
    rememberSubject(signedIn.subject);
  } catch {
    // The library has stored its user. Left beside an empty mirror or no
    // last-known subject, the next load would renew a session the entry
    // cannot track and no draft could start (U104; spec section 6). Both go,
    // so that load shows the sign-in screen.
    clearMirror();
    try {
      await (await authChunk()).discardUser();
    } catch {
      // Nothing more to remove from here; the sign-in still did not finish.
    }
    didNotFinish = true;
    return "failed";
  }
  window.history.replaceState(null, "", safeReturnPath(signedIn.returnTo));
  void flushOutbox({ ignoreBackoff: true });
  return "signed-in";
}
