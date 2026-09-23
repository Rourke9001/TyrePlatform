import { afterEach, describe, expect, it, vi } from "vitest";

import { installChunkReload } from "./chunkReload";

// A fake store: same get/set/throw contract as sessionStorage, without
// touching jsdom's real one, so the "blocked storage" case can be forced.
function fakeStorage(): Storage {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    removeItem: (key: string) => {
      data.delete(key);
    },
    clear: () => data.clear(),
    key: () => null,
    get length() {
      return data.size;
    },
  };
}

function dispatchPreloadError() {
  window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
}

describe("installChunkReload", () => {
  let uninstall: (() => void) | undefined;

  afterEach(() => {
    uninstall?.();
    uninstall = undefined;
  });

  it("reloads and stamps the storage on the first event", () => {
    const reload = vi.fn();
    const storage = fakeStorage();
    const now = 1_000;
    uninstall = installChunkReload({ reload, storage, now: () => now });

    dispatchPreloadError();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem("chunkReloadAt")).toBe("1000");
  });

  it("does not reload a second event inside the guard window", () => {
    const reload = vi.fn();
    const storage = fakeStorage();
    let now = 1_000;
    uninstall = installChunkReload({ reload, storage, now: () => now });

    dispatchPreloadError();
    now = 1_000 + 9_999;
    dispatchPreloadError();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads again once the guard window has passed", () => {
    const reload = vi.fn();
    const storage = fakeStorage();
    let now = 1_000;
    uninstall = installChunkReload({ reload, storage, now: () => now });

    dispatchPreloadError();
    now = 1_000 + 10_000;
    dispatchPreloadError();

    expect(reload).toHaveBeenCalledTimes(2);
    expect(storage.getItem("chunkReloadAt")).toBe(String(now));
  });

  it("never reloads when storage throws", () => {
    const reload = vi.fn();
    const storage: Storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      // The handler only ever calls getItem and setItem; the rest of the
      // Storage interface is unused but required by the type.
      removeItem: vi.fn(),
      clear: vi.fn(),
      key: () => null,
      length: 0,
    };
    uninstall = installChunkReload({ reload, storage, now: () => 1_000 });

    dispatchPreloadError();

    expect(reload).not.toHaveBeenCalled();
  });

  it("stops listening once uninstalled", () => {
    const reload = vi.fn();
    const storage = fakeStorage();
    uninstall = installChunkReload({ reload, storage, now: () => 1_000 });

    uninstall();
    dispatchPreloadError();

    expect(reload).not.toHaveBeenCalled();
  });
});
