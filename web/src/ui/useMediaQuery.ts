import { useCallback, useMemo, useSyncExternalStore } from "react";

import { breakpoint } from "../theme/tokens";

export const PHONE_QUERY = `(max-width: ${breakpoint.phone}px)`;

export function useMediaQuery(query: string): boolean {
  // One list per hook instance and query, not a module-level cache: tests
  // mock matchMedia per test, and a shared cache would carry one test's
  // list into the next (TYRE-238).
  const list = useMemo(() => window.matchMedia(query), [query]);
  const subscribe = useCallback(
    (changed: () => void) => {
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    [list],
  );
  return useSyncExternalStore(
    subscribe,
    () => list.matches,
    () => false,
  );
}

// The phone form is chosen in script, not by a CSS reflow, because a table
// set to display: block loses its table semantics for a screen reader
// (TYRE-238, the owner's card decision in comment 12938).
export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
