import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  draftRead,
  inspectionEnded,
  readStorageFaults,
  storageRefused,
  useStorageFaults,
  writeFailed,
} from "./storageFaults";

// setup.ts resets the store after every test, to the state a fresh tab starts in.
describe("the storage faults (TYRE-339)", () => {
  it("holds both faults at once", () => {
    storageRefused();
    writeFailed();
    expect(readStorageFaults()).toEqual({ unavailable: true, degraded: true });
  });

  it("clears unavailable on a read that succeeds, and degraded only when that read finds no draft", () => {
    storageRefused();
    writeFailed();
    draftRead(true);
    expect(readStorageFaults()).toEqual({ unavailable: false, degraded: true });
    draftRead(false);
    expect(readStorageFaults()).toEqual({ unavailable: false, degraded: false });
  });

  it("clears degraded when the inspection ends, and leaves unavailable standing", () => {
    storageRefused();
    writeFailed();
    inspectionEnded();
    expect(readStorageFaults()).toEqual({ unavailable: true, degraded: false });
  });

  it("keeps one snapshot while nothing changes, and renders a change", () => {
    const { result } = renderHook(() => useStorageFaults());
    const first = result.current;
    act(() => draftRead(false));
    expect(result.current).toBe(first);
    act(() => writeFailed());
    expect(result.current).toEqual({ unavailable: false, degraded: true });
  });
});
