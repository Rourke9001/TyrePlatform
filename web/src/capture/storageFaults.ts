import { useSyncExternalStore } from "react";

// TYRE-339: held in memory, above any page, because a store whose writes are
// failing cannot record its own failure, and a remount or a navigation must
// not forget it. A reload clears both, which is right: it shows what storage
// holds. NFR-USE-005: "unavailable" (the phone will not let the app save
// anything, before any inspection exists) and "degraded" (a write failed with
// an inspection in hand) stay distinct, and can both stand at once.
export interface StorageFaults {
  readonly unavailable: boolean;
  readonly degraded: boolean;
}

const CLEAR: StorageFaults = { unavailable: false, degraded: false };

// Replaced only when a flag changes: useSyncExternalStore re-renders forever
// on a fresh object per read (useOutbox.ts).
let faults: StorageFaults = CLEAR;
const listeners = new Set<() => void>();

function set(next: StorageFaults): void {
  if (next.unavailable === faults.unavailable && next.degraded === faults.degraded) return;
  faults = next;
  listeners.forEach((listen) => listen());
}

export function readStorageFaults(): StorageFaults {
  return faults;
}

export function useStorageFaults(): StorageFaults {
  return useSyncExternalStore(
    (listen) => {
      listeners.add(listen);
      return () => listeners.delete(listen);
    },
    readStorageFaults,
    () => CLEAR,
  );
}

// A draft read answered. Finding no draft means nothing is left for a failed
// write to have lost, so degraded clears with it.
export function draftRead(found: boolean): void {
  set({ unavailable: false, degraded: found ? faults.degraded : false });
}

// A draft read rejected, or a Start's write failed.
export function storageRefused(): void {
  set({ ...faults, unavailable: true });
}

// A reading, a mark, a header, a discard or a submit failed to write.
export function writeFailed(): void {
  set({ ...faults, degraded: true });
}

// The inspection's queue write or its discard resolved: the draft is off the
// phone, so the warning about it cannot outlive it.
export function inspectionEnded(): void {
  set({ ...faults, degraded: false });
}
