import { useState } from "react";

import { authChunk } from "../api/token";
import "./auth.css";

// The path to come back to rides in the request's state (callback.ts checks
// it is same-origin), so a sign-in from /capture/:id returns there.
function startSignIn(): Promise<void> {
  return authChunk().then((auth) =>
    auth.signIn(`${window.location.pathname}${window.location.search}`),
  );
}

export function SignInButton({ label }: { label: string }) {
  const [failed, setFailed] = useState(false);
  // A second tap on weak signal would start a second redirect, so taps are
  // ignored while a start is in flight. Back from the identity provider the
  // library's navigation resolves on pageshow (a bfcache restore), so the
  // button comes back when the start settles either way.
  const [pending, setPending] = useState(false);
  // One block, so the failure line sits under the button in a row as well as
  // in a column.
  return (
    <div className="auth-action">
      {/* aria-disabled, because a disabled button drops keyboard focus to
          the page. */}
      <button
        type="button"
        className="auth-primary"
        aria-disabled={pending}
        onClick={() => {
          if (pending) return;
          setFailed(false);
          setPending(true);
          startSignIn()
            .catch(() => setFailed(true))
            .finally(() => setPending(false));
        }}
      >
        {pending ? "Opening sign-in…" : label}
      </button>
      {failed && (
        <p role="alert" className="auth-note">
          Could not start sign-in. Find signal and try again.
        </p>
      )}
    </div>
  );
}
