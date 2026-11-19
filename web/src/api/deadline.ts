// Transport timing, not tenant policy (rule 5). The sign-in library's request
// timeout (oidc.ts), sign-in discovery (discovery.ts), a renewal and the
// redirect callback (token.ts, callback.ts), config.json (runtimeConfig.ts),
// every API call (client.ts) and the route error screen's escalated retry
// (RouteErrorBoundary.tsx) share this one value.
export const REQUEST_TIMEOUT_SECONDS = 10;

// A fetch or library timeout ends at the response headers, so a stalled body
// would hold its caller (docs/lessons.md, 2026-10-02). One deadline covers a
// request and its body reads: the signal aborts the fetch, and within()
// races each await against the expiry, since a stubbed or older fetch may
// never pass the abort on to the body. Past it the caller gets a plain
// Error, which the outbox (classify) and the queries read as offline.
export function deadline(what = "request", ms = REQUEST_TIMEOUT_SECONDS * 1000) {
  const controller = new AbortController();
  const expired = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(new Error(`${what} timed out`)));
  });
  // Raced on every await that uses it; this keeps an unraced expiry quiet.
  expired.catch(() => undefined);
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    within: <R>(work: Promise<R>): Promise<R> => Promise.race([work, expired]),
    end: () => clearTimeout(timer),
  };
}

// For work no single request's deadline bounds: the sign-in library's
// requests, and the route error screen's refresh, which waits on every query
// of its route and on any retry a query's own options set.
export async function bounded<T>(work: Promise<T>, what: string): Promise<T> {
  const bound = deadline(what);
  try {
    return await bound.within(work);
  } finally {
    bound.end();
  }
}
