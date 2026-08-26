import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { liveQuery } from "dexie";

import type { OutboxEntry } from "./outbox";
import { flushOutbox, isStale, listOutbox, startOutboxHeartbeat } from "./outbox";
import "./capture.css";

// One shared empty array, so a snapshot taken before the first emission keeps
// the same identity across renders. useSyncExternalStore re-renders forever if
// getSnapshot returns a fresh object each time.
const NONE: OutboxEntry[] = [];

// Dexie's own liveQuery, subscribed through useSyncExternalStore. Not a
// one-shot read: queueDraft and attemptSend run inside CaptureFlow with
// nothing connecting them to this component, so a mount-time read would show
// a stale count for the whole session.
//
// dexie-react-hooks packages this same subscription, but its type declarations
// import y-dexie and yjs — optional peers that would have to be installed and
// carried purely to satisfy a declaration file, and this project checks library
// declarations on purpose (tsconfig.json sets no skipLibCheck; tsconfig.e2e.json
// says why that exception exists and why it is one).
function useOutbox(): OutboxEntry[] {
  const held = useRef<OutboxEntry[]>(NONE);
  const subscribe = useCallback((changed: () => void) => {
    const subscription = liveQuery(() => listOutbox()).subscribe(
      (entries) => {
        held.current = entries;
        changed();
      },
      () => {
        // A dead IndexedDB is not an empty queue, but there is nothing here a
        // driver can act on and no count that would be honest to show.
        held.current = NONE;
        changed();
      },
    );
    return () => subscription.unsubscribe();
  }, []);
  return useSyncExternalStore(
    subscribe,
    () => held.current,
    () => NONE,
  );
}

// Mounted in the app shell rather than inside capture: a driver who has walked
// away from the vehicle still needs to know something is waiting to send.
export function OutboxIndicator() {
  const entries = useOutbox();

  useEffect(() => {
    // FR-OFF-009: on app-open, and whenever connectivity returns while the
    // app is open. Never Background Sync — iOS Safari has none and ADR-0009
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
  // FR-OFF-013: a permanent refusal is not 'waiting to send' — nothing is
  // going to happen to it without a person, and saying otherwise leaves a
  // driver watching a queue that will never drain.
  const waiting = entries.filter((e) => e.state !== "failed");
  const blocked = entries.filter((e) => e.state === "failed");
  const stale = waiting.filter((e) => isStale(e));

  return (
    <div className="cap-outbox" role="status">
      <div className="cap-outbox-lines">
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
        {stale.length > 0 && (
          <span className="cap-outbox-line cap-outbox-line--stop" role="alert">
            Waiting over two days — please find signal and sync.
          </span>
        )}
      </div>
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
