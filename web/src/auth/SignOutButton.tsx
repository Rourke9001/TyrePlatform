import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { authChunk, bearerMode, lastKnownSubject } from "../api/token";
import { heldCount } from "../capture/outbox";
import "./auth.css";

function stillHeld(n: number): string {
  return n === 1
    ? "You can't sign out yet. 1 inspection is still on this phone. Sign out once it has sent, or remove it if the office refused it."
    : `You can't sign out yet. ${n} inspections are still on this phone. Sign out once they have sent, or remove any the office refused.`;
}

// PD-S3: refused while anything is held, a draft or an outbox entry in any
// state. The guard lives here and not in signOut(), because the U104 undo
// has to sign a person out while another driver's work is held. A storage
// read that fails holds nothing, so sign-out goes ahead (heldCount).
export function SignOutButton() {
  const queryClient = useQueryClient();
  const [held, setHeld] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  // signOut() clears everything local before it can reject, and its resolve
  // is a navigation a bfcache restore can undo, so the button settles on
  // either and the next render re-reads the subject (TYRE-317).
  const [pending, setPending] = useState(false);
  if (!bearerMode() || lastKnownSubject() === null) return null;

  async function onClick() {
    if (pending) return;
    setPending(true);
    setFailed(false);
    // Emptied first so a repeat refusal with the same count is announced
    // again by the live region.
    setHeld(null);
    try {
      const count = await heldCount();
      if (count > 0) {
        setHeld(count);
        return;
      }
      let chunk;
      try {
        chunk = await authChunk();
      } catch {
        // With no signal for the lazy chunk the driver stays signed in, and
        // the line says so.
        setFailed(true);
        return;
      }
      try {
        await chunk.signOut();
      } catch {
        // Rejected after the local clear, so signed out locally.
      }
      // Settled with the page still here, so the cached actor goes and
      // /api/me is asked again (spec section 4, Signing out).
      void queryClient.resetQueries();
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-signout">
      {/* aria-disabled, so a focused button keeps keyboard focus while the
          guard reads storage. */}
      <button
        type="button"
        className="auth-secondary"
        aria-disabled={pending}
        onClick={() => void onClick()}
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      <p role="status" className="auth-note auth-live">
        {held !== null ? stillHeld(held) : ""}
      </p>
      {failed && (
        <p role="alert" className="auth-note">
          Could not sign out. Find signal and try again.
        </p>
      )}
    </div>
  );
}
