import { useEffect, type ReactNode } from "react";

import { authChunk, bearerMode, lastKnownSubject } from "../api/token";
import { AccessScreen } from "./AccessScreen";
import { useActor, useActorSettled, useAuthFailure } from "./actorContext";
import { SignInScreen } from "./SignInScreen";

// The sign-in or access screen shows while no GET /api/me has succeeded in
// this page load and the provider holds a failure (spec section 4). Once an
// actor is in hand a later 401 keeps the routes and SignInLine offers sign-in
// beside them, so a capture is never unmounted.
export function AuthGate({ children }: { children: ReactNode }) {
  const actor = useActor();
  const settled = useActorSettled();
  const failure = useAuthFailure();

  // After the first render, online, with a session stored, so a later renewal
  // in a dead zone finds the chunk already loaded (spec section 4). The module
  // cache makes a second call free, and a failure here changes nothing.
  useEffect(() => {
    if (bearerMode() && window.navigator.onLine && lastKnownSubject() !== null) {
      authChunk().catch(() => undefined);
    }
  }, []);

  if (!bearerMode() || actor !== null || !settled || failure === null) return <>{children}</>;
  if (failure === "signed-out") return <SignInScreen />;
  return <AccessScreen failure={failure} />;
}
