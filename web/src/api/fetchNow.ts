import type { QueryClient, QueryExecuteOptions } from "@tanstack/react-query";

// TYRE-340: the one way the route error screen replaces cached server data,
// and it never drops the copy. Three premises, each pinned in fetchNow.test.ts:
// QueryClient.query reaches an entry seeded with initialData that has never
// fetched, which refetchQueries skips; a failed fetch keeps the entry's data;
// and a fetch that pauses offline resolves at once, as refetchQueries does,
// so a driver without signal is not held for a bound that cannot be met.
export function fetchNow<T>(client: QueryClient, options: QueryExecuteOptions<T>): Promise<void> {
  const settled = client.query({ ...options, staleTime: 0 }).then(
    () => undefined,
    () => undefined,
  );
  // client.query runs to the retryer's start before it returns, and that
  // dispatches "pause" synchronously, so the state is readable here.
  if (client.getQueryState(options.queryKey)?.fetchStatus === "paused") return Promise.resolve();
  return settled;
}
