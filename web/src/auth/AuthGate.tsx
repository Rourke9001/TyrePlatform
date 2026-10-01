import { useEffect, type ReactNode } from "react";

import { authChunk, bearerMode, lastKnownSubject } from "../api/token";
import { AccessScreen } from "./AccessScreen";
import { useActor, useActorSettled, useAuthFailure } from "./actorContext";
import { SignInScreen } from "./SignInScreen";

// The routes give way only when this page load has no actor at all. A later
// 401 keeps the screen in hand and SignInLine offers sign-in beside it, so a
// capture is never unmounted (spec section 4).
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
