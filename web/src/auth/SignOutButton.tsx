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
  // signOut() clears everything local before it can reject, and its resolve
  // is a navigation that a bfcache restore can undo, so neither is the end of
  // sign-out: the button settles on either and the next render re-reads the
  // subject (spec section 4, Signing out).
  const [pending, setPending] = useState(false);
  if (!bearerMode() || lastKnownSubject() === null) return null;

  async function onClick() {
    setPending(true);
    try {
      const count = await heldCount();
      setHeld(count > 0 ? count : null);
      if (count === 0) await (await authChunk()).signOut();
    } catch {
      // Signed out locally, or the chunk did not load; the button re-reads
      // the subject on this settle and shows nothing misleading.
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="auth-signout">
      <button
        type="button"
        className="auth-secondary"
        disabled={pending}
        onClick={() => void onClick()}
      >
        Sign out
      </button>
      {held !== null && (
        <p role="status" className="auth-note">
          {stillHeld(held)}
        </p>
      )}
    </div>
  );
}
