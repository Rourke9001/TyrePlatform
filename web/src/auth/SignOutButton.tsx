import { useState } from "react";

import { authChunk, bearerMode, lastKnownSubject } from "../api/token";
import { heldCount } from "../capture/outbox";
import "./auth.css";

function stillHeld(n: number): string {
  const what = n === 1 ? "1 inspection is" : `${n} inspections are`;
  const when = n === 1 ? "it has" : "they have";
  return `${what} still on this phone. You can sign out once ${when} sent, or once you remove one the office refused.`;
}

// PD-S3: refused while anything is held, a draft or an outbox entry in any
// state. The guard lives here and not in signOut(), because the U104 undo
// has to sign a person out while another driver's work is held. A storage
// read that fails holds nothing, so sign-out goes ahead (heldCount).
export function SignOutButton() {
  const [held, setHeld] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  // signOut() clears everything local before it can reject, and its resolve
  // is a navigation that a bfcache restore can undo, so neither is the end of
  // sign-out (TYRE-317): the button settles on either and the next render
  // re-reads the subject. aria-disabled, not disabled, so a focused button
  // keeps keyboard focus while the guard reads storage.
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
        // No signal for the lazy chunk: still signed in, say so.
        setFailed(true);
        return;
      }
      try {
        await chunk.signOut();
      } catch {
        // Rejected after the local clear: signed out locally.
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-signout">
      <button
        type="button"
        className="auth-secondary"
        aria-disabled={pending}
        onClick={() => void onClick()}
      >
        Sign out
      </button>
      <p role="status" className="auth-note">
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
