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
  return (
    <>
      <button
        type="button"
        className="auth-primary"
        onClick={() => {
          setFailed(false);
          startSignIn().catch(() => setFailed(true));
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
