import { apiGet } from "../api/client";
import { rememberTenant } from "../api/token";

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
  // claim. The mirror keeps it for the branding cache key.
  tenantId: string;
}

export async function fetchMe(): Promise<Me> {
  const me = await apiGet<Me>("/api/me");
  rememberTenant(me.tenantId);
  return me;
}
