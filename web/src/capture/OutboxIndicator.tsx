import { useEffect } from "react";

import { bearerMode, stampSubject } from "../api/token";
import { useGateScreenShowing } from "../auth/actorContext";
import { SignInButton } from "../auth/SignInButton";

import { ConfirmDiscard } from "./ConfirmDiscard";
import { discardEntry, flushOutbox, isStale, mayCarry, startOutboxHeartbeat } from "./outbox";
import { useOutbox } from "./useOutbox";
import "./capture.css";

// Mounted in the app shell rather than inside capture: a driver who has walked
// away from the vehicle still needs to know something is waiting to send.
export function OutboxIndicator() {
  const entries = useOutbox();
  const gateShowing = useGateScreenShowing();

  useEffect(() => {
    // FR-OFF-009: on app-open, and whenever connectivity returns while the
    // app is open. Never Background Sync. iOS Safari has none and ADR-0009
    // settled that nothing here depends on it.
    void flushOutbox();
    const onOnline = () => void flushOutbox();
    window.addEventListener("online", onOnline);
    // FR-OFF-012's schedule needs a pulse while the app is open.
    const stopHeartbeat = startOutboxHeartbeat();
    return () => {
      window.removeEventListener("online", onOnline);
      stopHeartbeat();
    };
  }, []);

  if (entries.length === 0) return null;
  // FR-OFF-013: a permanent refusal is not 'waiting to send'. Nothing is
  // going to happen to it without a person, and saying otherwise leaves a
  // driver watching a queue that will never drain.
  const waiting = entries.filter((e) => e.state !== "failed");
  const blocked = entries.filter((e) => e.state === "failed");
  const stale = waiting.filter((e) => isStale(e));
  // U104: only this driver's held work; another driver's waits for them.
  // Hidden under a gate screen (useGateScreenShowing says why).
  const me = stampSubject();
  const needSignIn =
    bearerMode() && !gateShowing
      ? waiting.filter((e) => e.lastStatus === 401 && mayCarry(e, me)).length
      : 0;

  return (
    <div className="cap-outbox">
      {/* Only the lines are live, so the actions beside them, and the sign-in
          action's own alert, are not read into every status change. */}
      <div className="cap-outbox-lines" role="status">
        {/* NFR-USE-009: the count is in words, not only a coloured badge. */}
        {waiting.length > 0 && (
          <span className="cap-outbox-line">
            {waiting.length} inspection{waiting.length === 1 ? "" : "s"} waiting to send
          </span>
        )}
        {blocked.length > 0 && (
          <span className="cap-outbox-line cap-outbox-line--stop" role="alert">
            {blocked.length} inspection{blocked.length === 1 ? " needs" : "s need"} the office
          </span>
        )}
        {blocked.map((e) => (
          // ConfirmDiscard renders block content (section/p) once opened, which a
          // <span>, phrasing content only, cannot legally contain.
          <div key={e.clientUuid} className="cap-outbox-line cap-outbox-line--stop">
            {/* TYRE-167/FR-OFF-013: the recovery action once the office has
                taken the readings by phone, confirmed, never automatic.
                Named by vehicle so two failed entries get two
                distinguishable delete buttons. */}
            <ConfirmDiscard
              trigger={
                e.fleetNumber ? `The office has ${e.fleetNumber}` : "The office has this one"
              }
              question="Remove this inspection from the phone?"
              consequence="The office must already have these readings; nothing will be sent."
              confirm="Remove"
              onConfirm={() => void discardEntry(e.clientUuid)}
            />
          </div>
        ))}
        {waiting.some((e) => e.lastCode === "TY021") && (
          <span className="cap-outbox-line cap-outbox-line--stop" role="alert">
            {/* TYRE-215: the one refusal the driver can fix without the office. */}
            This phone&apos;s clock is ahead, so the office could not accept it yet. It will send
            later. Check the time.
          </span>
        )}
        {needSignIn > 0 && (
          <span className="cap-outbox-line">
            Sign in to send {needSignIn}&nbsp;inspection{needSignIn === 1 ? "" : "s"}
          </span>
        )}
        {stale.length > 0 && (
          <span className="cap-outbox-line cap-outbox-line--stop" role="alert">
            Waiting over two days. Please find signal and sync.
          </span>
        )}
      </div>
      {needSignIn > 0 && <SignInButton label="Sign in" />}
      {/* FR-OFF-010 */}
      <button
        type="button"
        className="cap-secondary cap-outbox-sync"
        onClick={() => void flushOutbox({ force: true })}
      >
        Sync now
      </button>
    </div>
  );
}
