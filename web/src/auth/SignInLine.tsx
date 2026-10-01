import { useSyncExternalStore } from "react";

import { bearerMode, onLapse, sessionLapsed } from "../api/token";
import { useActor } from "./actorContext";
import { SignInButton } from "./SignInButton";
import "./auth.css";

// Non-blocking: shown when a renewal found no session after the page already
// had an actor. Nothing redirects on its own (spec section 4).
export function SignInLine() {
  const lapsed = useSyncExternalStore(onLapse, sessionLapsed, () => false);
  const actor = useActor();
  if (!bearerMode() || !lapsed || actor === null) return null;
  return (
    <div className="auth-line" role="status">
      <p className="auth-body">Your sign-in has run out. Sign in to carry on.</p>
      <SignInButton label="Sign in" />
    </div>
  );
}
