// The one module that imports oidc-client-ts. It ships in the entry (U175,
// ADR-0016's amendment), since the driver's renewal, sign-in and sign-out wait
// on it. Two UserManagers share one store: a reader for storage, and a network
// manager built once discovery has answered (TYRE-471 spec, Two UserManagers
// over one store). createAuth exists so a test can hand it a navigator and
// metadata.
import {
  ErrorResponse,
  UserManager,
  WebStorageStateStore,
  type INavigator,
  type OidcMetadata,
  type User,
} from "oidc-client-ts";

import { REQUEST_TIMEOUT_SECONDS } from "../api/deadline";
import { fetchDiscovery } from "../api/discovery";
import { BRANDING_PREFIX, clearSession } from "../api/token";

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
  // The library's stored user, read through getUser() with no request. A user
  // with no oid or no expiry, or storage that cannot be read, is no session
  // (TYRE-471 spec, The session).
  storedSession(): Promise<Tokens | null>;
  // Removes the stored user only while it still holds this access token, in
  // the callback (callback.ts) and the token store (U111 B, token.ts).
  discardUser(accessToken: string): Promise<void>;
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
// brand. The library's own user is signOut()'s to remove, once it has read
// the hint.
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

// What a sign-in, a renewal and a sign-out need from discovery.
function isDiscovery(body: unknown): body is Partial<OidcMetadata> {
  const d = body as Partial<
    Record<"issuer" | "authorization_endpoint" | "token_endpoint", unknown>
  > | null;
  return (
    typeof d?.issuer === "string" &&
    typeof d.authorization_endpoint === "string" &&
    typeof d.token_endpoint === "string"
  );
}

// A document that names none of them is a plain Error, read as no signal
// (TYRE-471 spec, Discovery).
async function discover(url: string): Promise<Partial<OidcMetadata>> {
  const body = await fetchDiscovery(url);
  if (!isDiscovery(body)) throw new Error("sign-in discovery named no endpoints");
  return body;
}

export function createAuth(settings: AuthSettings, redirectNavigator?: INavigator): Auth {
  const base = {
    authority: settings.authority,
    client_id: settings.clientId,
    redirect_uri: `${settings.origin}/`,
    post_logout_redirect_uri: `${settings.origin}/`,
    scope: `openid profile offline_access ${settings.apiScope}`,
    // U102: the library's default store is sessionStorage, which the phone
    // empties whenever it closes the browser. Both managers share it, and it
    // keeps no copy in memory, so a write by one is the other's next read.
    userStore: new WebStorageStateStore({ store: window.localStorage }),
    // Renewal is the token store's decision (ADR-0016); the library's
    // default renews on its own timer.
    automaticSilentRenew: false,
    monitorSession: false,
    loadUserInfo: false,
    // oidc-client-ts sets no request timeout of its own. This one ends once
    // the response headers arrive, so the caller bounds the code exchange's
    // body (callback.ts, TYRE-388; docs/lessons.md, 2026-10-02).
    requestTimeoutInSeconds: REQUEST_TIMEOUT_SECONDS,
  };

  // Storage only: getUser() and removeUser() make no request, so a live token
  // never waits on discovery (TYRE-471 spec, Two UserManagers over one store).
  const reader = new UserManager(base);
  let network: Promise<UserManager> | null = settings.metadata
    ? Promise.resolve(new UserManager({ ...base, metadata: settings.metadata }, redirectNavigator))
    : null;

  // The library reads metadata only when a manager is built, so this one is
  // built once discovery has answered. A failure is forgotten, so the next
  // call fetches again (U199; TYRE-471 spec, Discovery).
  function networkManager(): Promise<UserManager> {
    if (network !== null) return network;
    const pending = discover(reader.settings.metadataUrl).then(
      (metadata) => new UserManager({ ...base, metadata }, redirectNavigator),
    );
    network = pending;
    void pending.catch(() => {
      if (network === pending) network = null;
    });
    return pending;
  }

  // Without a refresh token the library falls back to a hidden iframe on
  // silent_redirect_uri, which defaults to redirect_uri, "/". A session that
  // cannot renew is over, and its ID token names the person (spec section 6).
  async function refreshable(): Promise<string | null> {
    let user: User | null;
    try {
      user = await reader.getUser();
    } catch {
      // A stored value that does not parse is no session. It goes, so the
      // renewal is a lapse rather than every call failing as offline.
      await reader.removeUser().catch(() => undefined);
      return null;
    }
    if (user?.refresh_token) return user.refresh_token;
    if (user) await reader.removeUser();
    return null;
  }

  // Removes the stored user only while it still holds what the caller saw,
  // so a late settle never removes a session that a later renewal or sign-in
  // stored (TYRE-471 spec, Renewal).
  async function removeIf(holds: (user: User) => boolean): Promise<void> {
    const user = await reader.getUser();
    if (user !== null && holds(user)) await reader.removeUser();
  }

  return {
    // The redirect resolves only when the page comes back, so bounding it
    // would fail a slow but working sign-in (TYRE-381). Discovery before it
    // is bounded.
    async signIn(returnTo) {
      const manager = await networkManager();
      await manager.signinRedirect({ state: { returnTo } });
    },
    async completeSignIn(url) {
      const manager = await networkManager();
      const user = await manager.signinRedirectCallback(url);
      try {
        return { ...tokensOf(user), returnTo: returnToOf(user.state) };
      } catch (error) {
        // signinRedirectCallback has already stored this user. A sign-in the
        // store cannot use must leave nothing behind, or the next load renews
        // it and fails again, unless another sign-in has since replaced it
        // (TYRE-471 spec, The redirect callback).
        await removeIf((stored) => stored.access_token === user.access_token);
        throw error;
      }
    },
    async renew() {
      if ((await refreshable()) === null) return null;
      // Before the refresh token is sent, so bounding this cannot spend it
      // twice (TYRE-471 spec, Renewal). Its timeout is a plain Error, which
      // goes through as offline.
      const manager = await networkManager();
      // Read again: another tab's sign-out can remove the shared user during
      // discovery, and signinSilent reads it for itself.
      const sent = await refreshable();
      if (sent === null) return null;
      let renewed: User | null;
      try {
        // The settings' timeout does not reach the refresh request
        // (docs/lessons.md, 2026-10-01). Passed here it bounds only the wait
        // for headers, so the token store bounds the whole renewal
        // (TYRE-471 spec, Renewal).
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
            await removeIf((user) => user.refresh_token === sent);
            return null;
          }
          // form is the refresh POST body, refresh_token included.
          throw Object.assign(new Error(error.message), { error: error.error });
        }
        throw error;
      }
      if (renewed === null) {
        await removeIf((user) => user.refresh_token === sent);
        return null;
      }
      const renewedToken = renewed.access_token;
      try {
        return tokensOf(renewed);
      } catch {
        // A renewal that returns no oid cannot stamp or compare anything
        // (U104). It is a lapse, so its user is removed and the driver signs
        // in again.
        await removeIf((user) => user.access_token === renewedToken);
        return null;
      }
    },
    async storedSession() {
      try {
        const user = await reader.getUser();
        return user === null ? null : tokensOf(user);
      } catch {
        return null;
      }
    },
    async discardUser(accessToken) {
      await removeIf((user) => user.access_token === accessToken);
    },
    async signOut() {
      forgetIdentity();
      // The stored user goes before the first request that can fail: it holds
      // a refresh token and an ID token naming the driver (spec section 6).
      // Its ID token still goes as id_token_hint. Without the hint Entra may
      // show an account picker instead of returning to "/", and the U104 undo
      // depends on the return.
      const hint = (await reader.getUser().catch(() => null))?.id_token;
      await reader.removeUser();
      const manager = await networkManager();
      await manager.signoutRedirect(hint === undefined ? {} : { id_token_hint: hint });
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

// Building the managers reads window.localStorage, whose getter throws when
// site data is blocked. That is no session too (TYRE-471 spec, The session).
export async function storedSession(): Promise<Tokens | null> {
  try {
    return await auth().storedSession();
  } catch {
    return null;
  }
}

export function discardUser(accessToken: string): Promise<void> {
  return auth().discardUser(accessToken);
}
