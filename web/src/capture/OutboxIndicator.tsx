import { useEffect, useState } from "react";

import { stampSubject } from "../api/token";
import { SignInButton } from "../auth/SignInButton";
import { Button } from "../ui/Button";

import { ConfirmDiscard } from "./ConfirmDiscard";
import type { OutboxEntry } from "./outbox";
import {
  CLOCK_AHEAD_COPY,
  discardEntry,
  flushOutbox,
  heldBy,
  isStale,
  mayCarry,
  startOutboxHeartbeat,
} from "./outbox";
import { useOutbox, useSignInToSend } from "./useOutbox";
import "./outbox.css";

// Mounted in the app shell rather than inside capture: a driver who has walked
// away from the vehicle still needs to know something is waiting to send.
export function OutboxIndicator() {
  const entries = useOutbox();
  const needSignIn = useSignInToSend(entries);
  // TYRE-218: the entry whose removal IndexedDB refused. It stays in the
  // queue, so without a line the tap reads as ignored (NFR-USE-005).
  const [removeFailed, setRemoveFailed] = useState<string | null>(null);

  function remove(clientUuid: string) {
    setRemoveFailed(null);
    discardEntry(clientUuid).catch(() => setRemoveFailed(clientUuid));
  }

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
  // FR-OFF-020 warns of a stale entry once, naming what it waits on. The
  // clock and a sign-in this driver can make have lines of their own, which
  // the warning prefixes; any other cause gets its own line. Another
  // driver's sign-in hold is theirs to clear (U104).
  const me = stampSubject();
  const signsIn = (e: OutboxEntry) => needSignIn > 0 && e.lastStatus === 401 && mayCarry(e, me);
  const causeOf = (e: OutboxEntry) =>
    e.lastStatus === 401 && !mayCarry(e, me)
      ? "Another driver needs to sign in here to send it."
      : heldBy(e.lastStatus, e.lastCode);
  const staleClock = stale.some((e) => e.lastCode === "TY021");
  const staleSignIn = stale.some(signsIn);
  const others = stale.filter((e) => e.lastCode !== "TY021" && !signsIn(e));
  const staleOnSignal = others.some((e) => causeOf(e) === null);
  const staleCauses = [
    ...new Set(others.map(causeOf).filter((cause): cause is string => cause !== null)),
  ];

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
              onConfirm={() => remove(e.clientUuid)}
            />
            {removeFailed === e.clientUuid && (
              <span role="alert">Could not remove it. Try again.</span>
            )}
          </div>
        ))}
        {waiting.some((e) => e.lastCode === "TY021") && (
          <span className="cap-outbox-line cap-outbox-line--stop" role="alert">
            {staleClock && "Waiting over two days. "}
            {CLOCK_AHEAD_COPY}
          </span>
        )}
        {needSignIn > 0 && (
          <span className="cap-outbox-line">
            {staleSignIn && "Waiting over two days. "}
            Sign in to send {needSignIn}&nbsp;inspection{needSignIn === 1 ? "" : "s"}
          </span>
        )}
        {staleOnSignal && (
          <span className="cap-outbox-line cap-outbox-line--stop" role="alert">
            Waiting over two days. Please find signal and sync.
          </span>
        )}
        {staleCauses.map((cause) => (
          <span key={cause} className="cap-outbox-line cap-outbox-line--stop" role="alert">
            Waiting over two days. {cause}
          </span>
        ))}
      </div>
      {needSignIn > 0 && <SignInButton label="Sign in" />}
      {/* FR-OFF-010 */}
      <Button
        variant="secondary"
        size="glove"
        className="cap-outbox-sync"
        onClick={() => void flushOutbox({ force: true })}
      >
        Sync now
      </Button>
    </div>
  );
}
