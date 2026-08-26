import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom has no IndexedDB, so the durable-buffer tests would otherwise assert
// against a store that silently does not exist — which is the one failure mode
// FR-OFF-014 cannot tolerate going unnoticed.
import "fake-indexeddb/auto";

// Without this a component from one test is still mounted during the next,
// and queries match the wrong tree.
afterEach(cleanup);
