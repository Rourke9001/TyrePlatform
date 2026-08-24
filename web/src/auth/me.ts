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
}

export function fetchMe(): Promise<Me> {
  return apiGet<Me>("/api/me");
}
