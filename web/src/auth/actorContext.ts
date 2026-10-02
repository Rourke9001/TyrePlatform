import { createContext, useContext } from "react";

import { ApiError } from "../api/apiError";
import { bearerMode } from "../api/token";
import type { Me } from "./me";

// Context and hook live apart from the provider component: exporting a
// component and a non-component from one module kills Vite fast refresh
// (react-refresh/only-export-components).

// What stopped GET /api/me, named as the screen a person needs (ADR-0016).
export type AuthFailure = "signed-out" | "not-set-up" | "tenant-inactive" | "unavailable" | null;

export function failureOf(error: unknown): AuthFailure {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 401) return "signed-out";
  if (error.status === 403 && error.code === "tenant_inactive") return "tenant-inactive";
  if (error.status === 403 && (error.code === "forbidden" || error.code === "not_provisioned")) {
    return "not-set-up";
  }
  if (error.status === 503 && error.code === "auth_unavailable") return "unavailable";
  return null;
}

// The access screens' words (AccessScreen). CaptureDone shows the same body
// for an inspection that refusal holds, so the two never say different things.
export const ACCESS_COPY = {
  "not-set-up": {
    title: "Your account is not set up",
    body: "Ask your fleet office to set up your account.",
  },
  // FR-TEN-009's explanatory message.
  "tenant-inactive": {
    title: "Your company's account is not active",
    body: "This company's account is not active. Contact your fleet office.",
  },
  unavailable: {
    title: "Sign-in is unavailable",
    body: "Sign-in is unavailable right now. Try again shortly.",
  },
} as const;

export interface ActorState {
  actor: Me | null;
  // Whether GET /api/me has finished, either way. A capability check cannot
  // tell "no actor yet" from "actor holds nothing", and a one-shot routing
  // decision must not treat the first as the second (FR-DSH-001).
  settled: boolean;
  // Optional, so a provider that omits it reads as null.
  failure?: AuthFailure;
}

export const ActorContext = createContext<ActorState>({
  actor: null,
  settled: false,
});

export function useActor(): Me | null {
  return useContext(ActorContext).actor;
}

export function useAuthFailure(): AuthFailure {
  return useContext(ActorContext).failure ?? null;
}

// True while AuthGate shows a gate screen (sign-in, not set up, inactive or
// unavailable; spec section 4). Each carries its own action, so nothing
// mounted above the gate may offer another sign-in.
export function useGateScreenShowing(): boolean {
  const { actor, settled, failure } = useContext(ActorContext);
  return bearerMode() && actor === null && settled && (failure ?? null) !== null;
}

export function useActorSettled(): boolean {
  return useContext(ActorContext).settled;
}

export function useCan(capability: string): boolean {
  const actor = useActor();
  return actor?.capabilities.includes(capability) ?? false;
}

// Rules-of-hooks forbids calling useCan in a loop or conditionally, so an
// any-of check (D9 split the invite into ManageUsers/InviteDriver, ADR-0011)
// reads the actor once here instead.
export function useCanAny(capabilities: readonly string[]): boolean {
  const actor = useActor();
  return (
    actor !== null && capabilities.some((capability) => actor.capabilities.includes(capability))
  );
}
