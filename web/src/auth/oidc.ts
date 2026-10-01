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

import { BRANDING_PREFIX, MIRROR_KEY, SUBJECT_KEY } from "../api/token";

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
  // Removes the library's stored user without ending the Entra session: the
  // callback uses it when the mirror cannot be written (callback.ts).
  discardUser(): Promise<void>;
}

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

// What the entry wrote: the mirror, the last-known subject and every cached
// tenant brand. The library's own user is left for signoutRedirect.
function forgetIdentity(): void {
  const storage = window.localStorage;
  storage.removeItem(MIRROR_KEY);
  storage.removeItem(SUBJECT_KEY);
  for (let i = storage.length - 1; i >= 0; i--) {
    const key = storage.key(i);
    if (key?.startsWith(BRANDING_PREFIX)) storage.removeItem(key);
  }
}

export function createAuth(settings: AuthSettings, navigator?: INavigator): Auth {
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
      ...(settings.metadata ? { metadata: settings.metadata } : {}),
    },
    navigator,
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
        // The library has already stored this user (_buildUser,
        // oidc-client-ts 3.5.0). A sign-in the store cannot use must leave
        // nothing behind, or the next load renews it and fails again.
        await manager.removeUser();
        throw error;
      }
    },
    async renew() {
      const user = await manager.getUser();
      // Without a refresh token the library falls back to a hidden iframe on
      // silent_redirect_uri, which defaults to redirect_uri, "/".
      if (!user?.refresh_token) return null;
      let renewed: User | null;
      try {
        renewed = await manager.signinSilent();
      } catch (error) {
        // invalid_grant is the 24-hour refresh token lapsing (U102). Any
        // other refusal (temporarily_unavailable, server_error) and a
        // TypeError or ErrorTimeout go through: the outbox reads them as
        // offline and keeps the session.
        if (error instanceof ErrorResponse && error.error === "invalid_grant") {
          await manager.removeUser();
          return null;
        }
        throw error;
      }
      if (renewed === null) return null;
      try {
        return tokensOf(renewed);
      } catch {
        // A refreshed session with no oid cannot stamp or compare anything
        // (U104). It is a lapse: removed, and the driver signs in again.
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
