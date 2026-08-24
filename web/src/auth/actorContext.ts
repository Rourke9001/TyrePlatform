import { createContext, useContext } from "react";

import type { Me } from "./me";

// Context and hook live apart from the provider component: exporting a
// component and a non-component from one module kills Vite fast refresh
// (react-refresh/only-export-components).
export const ActorContext = createContext<Me | null>(null);

export function useActor(): Me | null {
  return useContext(ActorContext);
}

export function useCan(capability: string): boolean {
  const actor = useActor();
  return actor?.capabilities.includes(capability) ?? false;
}
