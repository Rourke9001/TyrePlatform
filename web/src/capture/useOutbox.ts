import { useCallback, useRef, useSyncExternalStore } from "react";
import { liveQuery } from "dexie";

import { bearerMode, stampSubject } from "../api/token";
import { useGateFailure } from "../auth/actorContext";
import type { OutboxEntry } from "./outbox";
import { listOutbox, mayCarry } from "./outbox";

// One shared empty array, so a snapshot taken before the first emission keeps
// the same identity across renders. useSyncExternalStore re-renders forever if
// getSnapshot returns a fresh object each time.
const NONE: OutboxEntry[] = [];

// Dexie's own liveQuery via useSyncExternalStore, not a one-shot read,
// because nothing else connects queueDraft/attemptSend to a component.
// ADR-0009's 2026-09-30 amendment says why not dexie-react-hooks.
export function useOutbox(): OutboxEntry[] {
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

// The N in the outbox band's "Sign in to send N": waiting work held on a 401
// that this driver can send, since another driver's waits for them (U104).
// Zero under a gate screen, which carries its own sign-in. SignInLine reads it
// too, so a lapsed session shows one "Sign in" (U107).
export function useSignInToSend(entries: OutboxEntry[]): number {
  const gateShowing = useGateFailure() !== null;
  if (!bearerMode() || gateShowing) return 0;
  const me = stampSubject();
  return entries.filter((e) => e.state !== "failed" && e.lastStatus === 401 && mayCarry(e, me))
    .length;
}
