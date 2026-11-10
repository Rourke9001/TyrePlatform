import { User, type IdTokenClaims } from "oidc-client-ts";

// The key oidc-client-ts 3.5.0 stores a user under ("oidc." + "user:" +
// authority + ":" + client_id), for bearerSession's authority and client id.
export const LIBRARY_USER_KEY = "oidc.user:https://idp.test/:pwa";

export interface PlantedSession {
  accessToken: string;
  // The profile's Entra oid. Null plants a user with none (ADR-0016).
  subject: string | null;
  // From now; negative is already expired. Default 3600.
  expiresInSeconds?: number;
  // Default "rt". Null plants a user that cannot renew.
  refreshToken?: string | null;
  idToken?: string;
}

// A session as the library stores it after a sign-in, and the one way a test
// plants one (TYRE-471 spec, Tests).
export function plantSession(session: PlantedSession): void {
  const profile: IdTokenClaims = {
    sub: "pairwise-1",
    iss: "https://idp.test/",
    aud: "pwa",
    exp: 0,
    iat: 0,
    ...(session.subject === null ? {} : { oid: session.subject }),
  };
  const user = new User({
    access_token: session.accessToken,
    token_type: "Bearer",
    profile,
    expires_at: Math.floor(Date.now() / 1000) + (session.expiresInSeconds ?? 3600),
    refresh_token: session.refreshToken === null ? undefined : (session.refreshToken ?? "rt"),
    id_token: session.idToken,
  });
  window.localStorage.setItem(LIBRARY_USER_KEY, user.toStorageString());
}

// The access token the library holds now, or null with no stored user.
export function storedAccessToken(): string | null {
  const raw = window.localStorage.getItem(LIBRARY_USER_KEY);
  return raw === null ? null : (JSON.parse(raw) as { access_token: string }).access_token;
}
