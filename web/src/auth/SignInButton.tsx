import { useState } from "react";

import { authChunk } from "../api/token";
import { reloadForAuthChunk } from "../shell/chunkReload";
import { Button } from "../ui/Button";
import "./auth.css";

// The path to come back to rides in the request's state (callback.ts checks
// it is same-origin), so a sign-in from /capture/:id returns there. Resolves
// true when a failed import reloads the page instead (U105, chunkReload.ts).
async function startSignIn(): Promise<boolean> {
  let auth;
  try {
    auth = await authChunk();
  } catch (error) {
    if (reloadForAuthChunk()) return true;
    throw error;
  }
  await auth.signIn(`${window.location.pathname}${window.location.search}`);
  return false;
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
      <Button
        variant="primary"
        // NFR-USE-004: a gloved tap at the capture keypad's size, not the
        // manager's 44px floor.
        size="glove"
        aria-disabled={pending}
        onClick={() => {
          if (pending) return;
          setFailed(false);
          setPending(true);
          // A reload keeps the button pending until the page goes.
          startSignIn().then(
            (reloading) => {
              if (!reloading) setPending(false);
            },
            () => {
              setFailed(true);
              setPending(false);
            },
          );
        }}
      >
        {pending ? "Opening sign-in…" : label}
      </Button>
      {failed && (
        <p role="alert" className="auth-note">
          Could not start sign-in. Find signal and try again.
        </p>
      )}
    </div>
  );
}
