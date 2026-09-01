import { QueryClient } from "@tanstack/react-query";
import { vi } from "vitest";

import type { Me } from "../auth/me";

// The default retries a failed request three times with backoff, which
// would schedule timers that outlive the test body.
export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

// The one construction site for a test actor. When the server adds a field
// to Me, tsc fails here and nowhere else — a search cannot find every
// literal a test file builds (docs/lessons.md, 31 Aug 2026).
export function me(overrides: Partial<Me> = {}): Me {
  return {
    userId: "u0",
    displayName: "Test",
    role: "CONTROLLER",
    capabilities: [],
    depots: [],
    timezone: "Africa/Johannesburg",
    displayCodePolicy: "FREE",
    ...overrides,
  };
}

export function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// The narrowing throws rather than casts: RequestInit.body is BodyInit, and
// String() on a Blob or FormData yields "[object Object]", which would make
// a JSON assertion pass while testing nothing (docs/lessons.md, 31 Aug 2026).
export function sentBody(call: number): unknown {
  const init = vi.mocked(fetch).mock.calls[call][1];
  if (typeof init?.body !== "string") {
    throw new Error(`call ${call} did not send a string body`);
  }
  return JSON.parse(init.body);
}
