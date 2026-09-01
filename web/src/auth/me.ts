import { apiGet } from "../api/client";

// Wire shape of GET /api/me (api/internal/httpapi). Capabilities are strings
// rather than a union: the server owns the vocabulary, and a client that
// cannot represent a capability it has not heard of would break on deploy
// ordering rather than degrade.
export interface Me {
  userId: string;
  displayName: string;
  role: string;
  capabilities: string[];
  depots: string[];
  // The tenant's IANA timezone. Every date a screen shows is formatted in it
  // (rule 6) — see web/src/time/tenantTime.ts, which is the only path.
  timezone: string;
  // D12: "FREE" or "GENERATED". A string rather than a union for the same
  // deploy-ordering reason as capabilities — the server owns the
  // vocabulary, and a client built against today's two values must not
  // break on a third it has not heard of yet.
  displayCodePolicy: string;
}

export function fetchMe(): Promise<Me> {
  return apiGet<Me>("/api/me");
}
