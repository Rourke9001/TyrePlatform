import { useEffect, useState } from "react";

import { OTHER_DRIVER_KEY } from "../api/token";
import { signInDidNotFinish } from "./callback";
import { SignInButton } from "./SignInButton";
import "./auth.css";

// Set only before the U104 undo signs someone out. Read in the initialiser and
// cleared in an effect, because StrictMode runs an initialiser twice.
function readMarker(): boolean {
  try {
    return window.sessionStorage.getItem(OTHER_DRIVER_KEY) === "1";
  } catch {
    return false;
  }
}

// No waiting count here. The outbox band above the gate carries the one count,
// beside the Remove action for each refused inspection (U107).
export function SignInScreen() {
  const [otherDriver] = useState(readMarker);
  useEffect(() => {
    try {
      window.sessionStorage.removeItem(OTHER_DRIVER_KEY);
    } catch {
      // Best effort.
    }
  }, []);

  return (
    <section className="auth-screen" aria-labelledby="sign-in-heading">
      <h1 id="sign-in-heading" className="auth-title">
        Sign in
      </h1>
      {otherDriver ? (
        <p role="alert" className="auth-body">
          Inspections captured by another driver are waiting on this phone. They need to sign in
          here to send them before anyone else can use it.
        </p>
      ) : (
        <p className="auth-body">Sign in with the email address your fleet office has for you.</p>
      )}
      {signInDidNotFinish() && (
        <p role="alert" className="auth-body">
          Sign-in did not finish. Try again.
        </p>
      )}
      <SignInButton label="Email me a sign-in code" />
    </section>
  );
}
