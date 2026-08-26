import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no IndexedDB, so the durable-buffer tests would otherwise assert
// against a store that silently does not exist — which is the one failure mode
// FR-OFF-014 cannot tolerate going unnoticed.
import "fake-indexeddb/auto";

// toHaveTextContent and friends — component tests assert what the driver
// sees, not internal state.
import "@testing-library/jest-dom/vitest";

// @testing-library/react's asyncWrapper drains microtasks after every
// userEvent/waitFor call through a real setTimeout(resolve, 0), advancing a
// fake clock to fire it immediately if it detects one — but its detection
// (@testing-library/react/dist/pure.js) only checks for a `jest` global.
// Vitest has none, so under vi.useFakeTimers() that advance is silently
// skipped and the very first userEvent call after enabling fake timers hangs
// forever: the promise it awaits has nothing left to resolve it. Satisfying
// the detection is the fix, not widening which timers are faked — the
// pending call is real regardless of toFake, and only this shim reaches it.
interface JestShim {
  advanceTimersByTime: (ms: number) => void;
}
(globalThis as typeof globalThis & { jest?: JestShim }).jest ??= {
  advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms),
};

// Without this a component from one test is still mounted during the next,
// and queries match the wrong tree.
afterEach(cleanup);
