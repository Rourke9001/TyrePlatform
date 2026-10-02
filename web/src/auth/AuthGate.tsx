import { useEffect, type ReactNode } from "react";

import { authChunk, bearerMode, lastKnownSubject } from "../api/token";
import { AccessScreen } from "./AccessScreen";
import { useGateFailure } from "./actorContext";
import { SignInScreen } from "./SignInScreen";

// The sign-in or access screen shows while the actor query holds no actor and
// the provider names a failure, through any refetch (spec section 4). A
// sign-out cache reset empties the actor, so the screen can show after an
// earlier success. Once an actor is in hand a later 401 keeps the routes and
// the shell offers sign-in beside them, so a capture is never unmounted.
export function AuthGate({ children }: { children: ReactNode }) {
  const failure = useGateFailure();

  // After the first render, online, with a session stored, so a later renewal
  // in a dead zone finds the chunk already loaded (spec section 4). A failed
  // warm-up can fail every later import of the chunk until a reload, because
  // Chrome and released Safari keep the failure in the module map (TYRE-381).
  useEffect(() => {
    if (bearerMode() && window.navigator.onLine && lastKnownSubject() !== null) {
      authChunk().catch(() => undefined);
    }
  }, []);

  if (failure === null) return <>{children}</>;
  if (failure === "signed-out") return <SignInScreen />;
  return <AccessScreen failure={failure} />;
}
