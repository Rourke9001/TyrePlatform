import {
  OTHER_DRIVER_KEY,
  bearerMode,
  forgetTenant,
  recordObtained,
  rememberSubject,
} from "../api/token";
import { bounded } from "../api/deadline";
import { flushOutbox, heldStamps } from "../capture/outbox";
import { completeSignIn, discardUser, signOut, type SignedIn } from "./oidc";

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
// read back from storage (ADR-0016, spec section 4). It tests the parsed path,
// because new URL() turns "/..//evil.test" into "//evil.test", which a
// browser reads as another host.
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
function othersHeld(stamps: string[], subject: string): boolean {
  return stamps.some((stamp) => stamp !== subject);
}

// U104: sign the newcomer out through the full signOut(), marker first. A
// rejection (end-session metadata unreachable offline) still counts as signed
// out, because signOut() clears local state before it can reject (oidc.ts).
async function undoSignIn(): Promise<void> {
  try {
    window.sessionStorage.setItem(OTHER_DRIVER_KEY, "1");
  } catch {
    // Without the marker the screen shows its neutral line instead.
  }
  try {
    await signOut();
  } catch {
    // Best effort.
  }
}

async function discardLate(late: SignedIn): Promise<void> {
  try {
    await discardUser(late.accessToken);
  } catch {
    // Best effort. A renewal adopts it only for the last-known subject
    // (U111 B, token.ts).
  }
}

export type RedirectOutcome = "none" | "signed-in" | "failed" | "undone";

// Runs before the first render (main.tsx), so the U104 compare comes before
// anything calls the API as the person who just signed in (ADR-0016, U104).
export async function completeRedirect(): Promise<RedirectOutcome> {
  const url = new URL(window.location.href);
  if (!bearerMode() || !isRedirectCallback(url)) return "none";

  // Read before the exchange, so nothing is awaited from the library storing
  // the user to the subject write below. A renewal in another tab settling
  // in between would find an oid that is not the subject and remove the
  // user (TYRE-471 spec, The redirect callback).
  const stamps = await heldStamps();

  // Bounded, because the first render waits on this (TYRE-388).
  // Started inside the chain, so a synchronous throw (blocked storage) is
  // caught below like any failed exchange.
  const exchange = Promise.resolve(url.href).then(completeSignIn);
  let signedIn: SignedIn;
  try {
    signedIn = await bounded(exchange, "sign-in callback");
  } catch {
    didNotFinish = true;
    // An exchange that finishes past the bound stores a user the compare
    // below never saw, so it goes too, while it is still that exchange's
    // (U104; TYRE-471 spec, The redirect callback).
    exchange.then(discardLate, () => undefined);
    return "failed";
  } finally {
    // Success or not, so a reload cannot replay a spent code.
    window.history.replaceState(null, "", "/");
  }

  if (othersHeld(stamps, signedIn.subject)) {
    await undoSignIn();
    return "undone";
  }

  // Before anything calls the API, and with nothing awaited since the
  // exchange: the tenant key goes, the subject is written, and the token is
  // recorded as fresh (TYRE-471 spec, The redirect callback).
  try {
    forgetTenant();
    rememberSubject(signedIn.subject);
  } catch {
    // The library has stored its user, and its ID token names the person
    // (spec section 6). With no last-known subject it serves no call and no
    // draft could start under it (U104). It goes while it is still this
    // sign-in's, so the next load shows the sign-in screen.
    try {
      await discardUser(signedIn.accessToken);
    } catch {
      // Best effort.
    }
    didNotFinish = true;
    return "failed";
  }
  recordObtained(signedIn.accessToken);
  window.history.replaceState(null, "", safeReturnPath(signedIn.returnTo));
  void flushOutbox({ ignoreBackoff: true });
  return "signed-in";
}
