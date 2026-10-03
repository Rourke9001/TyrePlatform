import { useSyncExternalStore } from "react";

import { bearerMode, onLapse, sessionLapsed } from "../api/token";
import { useOutbox, useSignInToSend } from "../capture/useOutbox";
import { useActor } from "./actorContext";
import { SignInButton } from "./SignInButton";
import "./auth.css";

// Non-blocking. The line shows when a renewal found no session after the page
// already had an actor, and nothing redirects on its own (spec section 4).
export function SignInLine() {
  const lapsed = useSyncExternalStore(onLapse, sessionLapsed, () => false);
  const actor = useActor();
  // U107: while the outbox band offers "Sign in to send N", its button is the
  // one sign-in, beside the work it unblocks.
  const bandOffers = useSignInToSend(useOutbox()) > 0;
  if (!bearerMode()) return null;
  const shown = lapsed && actor !== null && !bandOffers;
  // The status stays mounted while empty, so the lapse is an update a screen
  // reader announces. The button sits outside it, so its label is not read
  // as part of the message.
  return (
    <div className={shown ? "auth-line" : undefined}>
      <p role="status" className="auth-body auth-live">
        {shown ? "Your sign-in has run out. Sign in to carry on." : ""}
      </p>
      {shown && <SignInButton label="Sign in" />}
    </div>
  );
}
