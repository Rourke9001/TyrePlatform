import { createContext, useContext } from "react";

import type { Me } from "./me";

// Context and hook live apart from the provider component: exporting a
// component and a non-component from one module kills Vite fast refresh
// (react-refresh/only-export-components).
export interface ActorState {
  actor: Me | null;
  // Whether GET /api/me has finished, either way. A capability check cannot
  // tell "no actor yet" from "actor holds nothing", and a one-shot routing
  // decision must not treat the first as the second (FR-DSH-001).
  settled: boolean;
}

export const ActorContext = createContext<ActorState>({
  actor: null,
  settled: false,
});

export function useActor(): Me | null {
  return useContext(ActorContext).actor;
}

export function useActorSettled(): boolean {
  return useContext(ActorContext).settled;
}

export function useCan(capability: string): boolean {
  const actor = useActor();
  return actor?.capabilities.includes(capability) ?? false;
}
