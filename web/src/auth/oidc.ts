// The one module that imports oidc-client-ts, reached only through the token
// store's authChunk() (ADR-0016), so the library stays out of the capture
// entry. The module functions act on one UserManager built from VITE_AUTH_*;
// createAuth exists so a test can hand it a navigator and metadata.
import {
  ErrorResponse,
  UserManager,
  WebStorageStateStore,
  type INavigator,
  type OidcMetadata,
  type User,
} from "oidc-client-ts";

import { BRANDING_PREFIX, REQUEST_TIMEOUT_SECONDS, clearSession } from "../api/token";

export interface Tokens {
  accessToken: string;
  expiresAt: number;
  subject: string;
}

export interface SignedIn extends Tokens {
  returnTo: unknown;
}

export interface AuthSettings {
  authority: string;
  clientId: string;
  apiScope: string;
  origin: string;
  metadata?: Partial<OidcMetadata>;
}

export interface Auth {
  signIn(returnTo: string): Promise<void>;
  completeSignIn(url: string): Promise<SignedIn>;
  renew(): Promise<Tokens | null>;
  signOut(): Promise<void>;
  // Removes the library's stored user without ending the Entra session: in
  // the callback when the mirror cannot be written (callback.ts), and in the
  // token store when a renewal names another driver (U111 B, token.ts).
  discardUser(): Promise<void>;
}

const TRANSIENT_CODES = new Set(["server_error", "temporarily_unavailable"]);

function tokensOf(user: User): Tokens {
  const oid = user.profile.oid;
  if (typeof oid !== "string" || user.expires_at === undefined) {
    throw new Error("the sign-in returned no oid or no expiry");
  }
  return { accessToken: user.access_token, expiresAt: user.expires_at * 1000, subject: oid };
}

function returnToOf(state: unknown): unknown {
  return typeof state === "object" && state !== null && "returnTo" in state
    ? state.returnTo
    : undefined;
}

// What the entry wrote: the token store's session and every cached tenant
// brand. The library's own user is left for signoutRedirect.
function forgetIdentity(): void {
  clearSession();
  const storage = window.localStorage;
  const branded: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(BRANDING_PREFIX)) branded.push(key);
  }
  branded.forEach((key) => storage.removeItem(key));
}

export function createAuth(settings: AuthSettings, redirectNavigator?: INavigator): Auth {
  const manager = new UserManager(
    {
      authority: settings.authority,
      client_id: settings.clientId,
      redirect_uri: `${settings.origin}/`,
      post_logout_redirect_uri: `${settings.origin}/`,
      scope: `openid profile offline_access ${settings.apiScope}`,
      // U102: the library's default store is sessionStorage, which the phone
      // empties whenever it closes the browser.
      userStore: new WebStorageStateStore({ store: window.localStorage }),
      // Renewal is the token store's decision (ADR-0016); the library's
      // default renews on its own timer.
      automaticSilentRenew: false,
      monitorSession: false,
      loadUserInfo: false,
      // oidc-client-ts sets no request timeout of its own, and a stalled
      // discovery, key or code-exchange request would leave the page blank
      // (ADR-0016). This one ends once the response headers arrive, so it
      // does not bound a stalled body (docs/lessons.md, 2026-10-02).
      requestTimeoutInSeconds: REQUEST_TIMEOUT_SECONDS,
      ...(settings.metadata ? { metadata: settings.metadata } : {}),
    },
    redirectNavigator,
  );

  return {
    async signIn(returnTo) {
      await manager.signinRedirect({ state: { returnTo } });
    },
    async completeSignIn(url) {
      const user = await manager.signinRedirectCallback(url);
      try {
        return { ...tokensOf(user), returnTo: returnToOf(user.state) };
      } catch (error) {
        // signinRedirectCallback has already stored this user. A sign-in the
        // store cannot use must leave nothing behind, or the next load renews
        // it and fails again (spec section 4, The token store).
        await manager.removeUser();
        throw error;
      }
    },
    async renew() {
      const user = await manager.getUser();
      // Without a refresh token the library falls back to a hidden iframe on
      // silent_redirect_uri, which defaults to redirect_uri, "/".
      if (!user?.refresh_token) {
        // A session that cannot renew is over, and its ID token names the
        // person (spec section 6).
        if (user) await manager.removeUser();
        return null;
      }
      let renewed: User | null;
      try {
        // The settings' timeout does not reach the refresh request
        // (docs/lessons.md, 2026-10-01). Passed here it bounds only the wait
        // for headers, so the token store bounds the whole renewal (spec
        // section 4, Renewal).
        renewed = await manager.signinSilent({
          silentRequestTimeoutInSeconds: REQUEST_TIMEOUT_SECONDS,
        });
      } catch (error) {
        // Spec section 4 "Renewal": a refused refresh token ends the
        // session, so any ErrorResponse lapses except the provider's own
        // transient codes. A TypeError, ErrorTimeout or plain Error (a
        // captive portal's HTML) is offline, not a refusal, and goes through.
        if (error instanceof ErrorResponse) {
          if (!TRANSIENT_CODES.has(error.error ?? "")) {
            await manager.removeUser();
            return null;
          }
          // form is the refresh POST body, refresh_token included.
          throw Object.assign(new Error(error.message), { error: error.error });
        }
        throw error;
      }
      try {
        if (renewed === null) throw new Error("no user after renewal");
        return tokensOf(renewed);
      } catch {
        // A renewal that returns no user, or one with no oid, cannot stamp or
        // compare anything (U104). It is a lapse, so the user is removed and
        // the driver signs in again.
        await manager.removeUser();
        return null;
      }
    },
    async discardUser() {
      await manager.removeUser();
    },
    async signOut() {
      forgetIdentity();
      // signoutRedirect reads the stored user for id_token_hint, then removes
      // it. Without the hint Entra may show an account picker instead of
      // returning to "/", and the U104 undo depends on the return.
      await manager.signoutRedirect();
    },
  };
}

let instance: Auth | null = null;

function auth(): Auth {
  instance ??= createAuth({
    authority: import.meta.env.VITE_AUTH_AUTHORITY ?? "",
    clientId: import.meta.env.VITE_AUTH_CLIENT_ID ?? "",
    apiScope: import.meta.env.VITE_AUTH_API_SCOPE ?? "",
    origin: window.location.origin,
  });
  return instance;
}

export function signIn(returnTo: string): Promise<void> {
  return auth().signIn(returnTo);
}

export function completeSignIn(url: string): Promise<SignedIn> {
  return auth().completeSignIn(url);
}

export function renew(): Promise<Tokens | null> {
  return auth().renew();
}

export function signOut(): Promise<void> {
  return auth().signOut();
}

export function discardUser(): Promise<void> {
  return auth().discardUser();
}
