import { apiGet } from "../api/client";

// Wire shape of GET /api/me. Capabilities are strings, not a union: the
// server owns the vocabulary, so an unrecognised one degrades instead of
// breaking on deploy ordering.
export interface Me {
  userId: string;
  displayName: string;
  role: string;
  capabilities: string[];
  depots: string[];
  // The tenant's IANA timezone. Every date a screen shows is formatted in it
  // (rule 6). See web/src/time/tenantTime.ts, which is the only path.
  timezone: string;
  // D12: "FREE" or "GENERATED", kept as a string for the same deploy-ordering
  // reason as capabilities above; a third value must not break this client.
  displayCodePolicy: string;
}

export function fetchMe(): Promise<Me> {
  return apiGet<Me>("/api/me");
}
