import { useCallback, useSyncExternalStore } from "react";

import { breakpoint } from "../theme/tokens";

export const PHONE_QUERY = `(max-width: ${breakpoint.phone}px)`;

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (changed: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", changed);
      return () => list.removeEventListener("change", changed);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

// The phone form is chosen in script, not by a CSS reflow, because a table
// set to display: block loses its table semantics for a screen reader
// (ruling P2, TYRE-238).
export function usePhone(): boolean {
  return useMediaQuery(PHONE_QUERY);
}
