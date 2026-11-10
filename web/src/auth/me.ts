import { ApiError, apiGet } from "../api/client";
import { lastKnownSubject, rememberTenant } from "../api/token";

// Wire shape of GET /api/me. Capabilities are strings, not a union: the
// server owns the vocabulary, so an unrecognised one degrades instead of
// breaking on deploy ordering.
export interface Me {
  userId: string;
  displayName: string;
  role: string;
  capabilities: string[];
  depots: string[];
  // U87: "TENANT" or "DEPOT", the breadth the server reads for this actor.
  // A string, as capabilities are, so a new value cannot break this client
  // on deploy order; nothing here derives it from role.
  scope: string;
  // The tenant's IANA timezone. Every date a screen shows is formatted in it
  // (rule 6). See web/src/time/tenantTime.ts, which is the only path.
  timezone: string;
  // D12: "FREE" or "GENERATED", kept as a string for the same deploy-ordering
  // reason as capabilities above; a third value must not break this client.
  displayCodePolicy: string;
  // The tenant RLS proved for this request (ADR-0016), never the token's
  // claim. rememberTenant keeps it for the branding cache key (token.ts).
  tenantId: string;
  // FR-CFG-021, FR-CFG-022: the codes money, pressure and distance render
  // with (src/api/money.ts, src/units/units.ts). Optional because an API
  // older than this client omits them, and each reader has a fallback.
  currency?: string;
  pressureUnit?: string;
  distanceUnit?: string;
}

// The API's 401 carries no code (client.ts). The store's own signed_out
// does, and a retry would answer it the same (TYRE-471 spec, Sending).
function refusedByApi(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401 && error.code === null;
}

export async function fetchMe(): Promise<Me> {
  // Before the first call, so rememberTenant can tell whose answer it is
  // (token.ts).
  const subject = lastKnownSubject();
  let me: Me;
  try {
    me = await apiGet<Me>("/api/me");
  } catch (error) {
    // Once, with the store's next token: a reload can send a refused token
    // whose renewal had not landed, and only this query shows the sign-in
    // screen (TYRE-471 spec, Sending; RFC 6750, section 3.1).
    if (!refusedByApi(error)) throw error;
    me = await apiGet<Me>("/api/me");
  }
  rememberTenant(me.tenantId, subject);
  return me;
}
