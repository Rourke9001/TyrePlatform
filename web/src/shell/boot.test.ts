import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { boot, type BootSteps } from "./boot";

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

interface Fakes {
  steps: BootSteps;
  calls: string[];
  listeners: Set<() => void>;
  retries: (() => void)[];
}

function fakes(loadConfig: () => Promise<void>, completeRedirect = () => Promise.resolve()): Fakes {
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const retries: (() => void)[] = [];
  const steps: BootSteps = {
    loadConfig: () => {
      calls.push("loadConfig");
      return loadConfig();
    },
    completeRedirect: () => {
      calls.push("completeRedirect");
      return completeRedirect();
    },
    render: () => calls.push("render"),
    renderFailure: (retry) => {
      calls.push("renderFailure");
      retries.push(retry);
    },
    onOnline: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { steps, calls, listeners, retries };
}

describe("boot", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("completes the redirect and renders once the configuration loads", async () => {
    const f = fakes(() => Promise.resolve());
    await boot(f.steps);
    expect(f.calls).toEqual(["loadConfig", "completeRedirect", "render"]);
    expect(f.listeners.size).toBe(0);
  });

  // The redirect waits for the configuration (boot.ts says why).
  it("shows the failure and waits for the signal when the configuration fails", async () => {
    const f = fakes(() => Promise.reject(new Error("no config")));
    void boot(f.steps);
    await flush();
    expect(f.calls).toEqual(["loadConfig", "renderFailure"]);
    expect(f.listeners.size).toBe(1);
    expect(console.error).toHaveBeenCalledWith("the app could not load config.json");
  });

  it("retries in place from the failure screen", async () => {
    const loadConfig = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("no config"))
      .mockResolvedValueOnce(undefined);
    const f = fakes(loadConfig);
    const booted = boot(f.steps);
    await flush();
    f.retries[0]();
    await booted;
    expect(f.calls).toEqual([
      "loadConfig",
      "renderFailure",
      "loadConfig",
      "completeRedirect",
      "render",
    ]);
    expect(f.listeners.size).toBe(0);
  });

  it("retries when the signal returns, and never twice at once", async () => {
    let settle: () => void = () => undefined;
    const loadConfig = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("no config"))
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
      );
    const f = fakes(loadConfig);
    const booted = boot(f.steps);
    await flush();
    const [online] = f.listeners;
    online();
    f.retries[0]();
    expect(loadConfig).toHaveBeenCalledTimes(2);
    settle();
    await booted;
    expect(f.calls.filter((c) => c === "render")).toHaveLength(1);
  });

  it("still renders when the redirect fails", async () => {
    const f = fakes(
      () => Promise.resolve(),
      () => Promise.reject(new Error("bad state")),
    );
    await boot(f.steps);
    expect(f.calls).toEqual(["loadConfig", "completeRedirect", "render"]);
    expect(console.error).toHaveBeenCalledWith("sign-in callback failed");
  });
});
