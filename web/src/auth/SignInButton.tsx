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
  // A second tap on weak signal would start a second redirect, so the button
  // stays disabled until the start fails; a started one leaves the page.
  const [pending, setPending] = useState(false);
  return (
    <>
      <button
        type="button"
        className="auth-primary"
        disabled={pending}
        onClick={() => {
          setFailed(false);
          setPending(true);
          startSignIn().catch(() => {
            setPending(false);
            setFailed(true);
          });
        }}
      >
        {label}
      </button>
      {failed && (
        <p role="alert" className="auth-note">
          Could not start sign-in. Find signal and try again.
        </p>
      )}
    </>
  );
}
