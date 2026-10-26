import type { ReactNode } from "react";
import { MemoryRouter, useInRouterContext } from "react-router";

// The gallery's own test renders it without a router and the dev route
// inside one, so a link sample brings a router only when it has none.
export function Routed({ children }: { children: ReactNode }) {
  return useInRouterContext() ? children : <MemoryRouter>{children}</MemoryRouter>;
}
