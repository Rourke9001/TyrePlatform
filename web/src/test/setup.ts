import { afterEach, vi } from "vitest";
import { cleanup, configure } from "@testing-library/react";

// findBy* polls until this ceiling, so raising it changes nothing about what
// passes, only how long a loaded box may take to get there. The default
// second is not enough when `make check` runs these beside the Go container
// and the database.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no IndexedDB, so the durable-buffer tests would otherwise assert
// against a store that silently does not exist, which is the one failure mode
// FR-OFF-014 cannot tolerate going unnoticed.
import "fake-indexeddb/auto";

// toHaveTextContent and friends. Component tests assert what the driver
// sees, not internal state.
import "@testing-library/jest-dom/vitest";

// @testing-library/react's asyncWrapper only advances a fake clock if it
// detects a `jest` global; vitest has none, so under vi.useFakeTimers() the
// first userEvent call hangs forever. This shim satisfies that detection;
// widening which timers are faked would not fix it.
interface JestShim {
  advanceTimersByTime: (ms: number) => void;
}
(globalThis as typeof globalThis & { jest?: JestShim }).jest ??= {
  advanceTimersByTime: (ms) => vi.advanceTimersByTime(ms),
};

// Without this a component from one test is still mounted during the next,
// and queries match the wrong tree.
afterEach(cleanup);

// jsdom has no matchMedia, and usePhone() calls it on every render. The stub
// answers false, the desktop width, so every test renders the desktop form
// unless it forces the phone with forceMatchMedia (src/test/media.ts).
import { TestMediaQueryList } from "./media";
// lint/moneyStaysString.test.ts runs in node, where there is no window.
if (typeof window !== "undefined") {
  (window as { matchMedia?: Window["matchMedia"] }).matchMedia ??= (query) =>
    new TestMediaQueryList(query, false);
}
