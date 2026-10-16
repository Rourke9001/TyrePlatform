import { afterEach, describe, expect, it, vi } from "vitest";

import { RuntimeConfigError, createRuntimeConfig, parseApiOrigin } from "./runtimeConfig";
import { REQUEST_TIMEOUT_SECONDS } from "./token";

type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

function answering(status: number, body: string): ReturnType<typeof vi.fn<FetchFn>> {
  return vi.fn<FetchFn>(() => Promise.resolve(new Response(body, { status })));
}

const CONFIG = JSON.stringify({ apiOrigin: "https://api.example.test" });

describe("parseApiOrigin", () => {
  it("accepts an absolute origin", () => {
    expect(
      parseApiOrigin({ apiOrigin: "https://ca-api-staging.example.azurecontainerapps.io" }),
    ).toBe("https://ca-api-staging.example.azurecontainerapps.io");
    expect(parseApiOrigin({ apiOrigin: "http://localhost:4173" })).toBe("http://localhost:4173");
  });

  it.each([
    "https://api.example.test/",
    "https://api.example.test/api",
    "",
    "*",
    "/api",
    "file:///x",
    42,
  ])("refuses the apiOrigin %j", (apiOrigin) => {
    expect(() => parseApiOrigin({ apiOrigin })).toThrow(RuntimeConfigError);
  });

  it.each([null, {}, "x"])("refuses the body %j", (body) => {
    expect(() => parseApiOrigin(body)).toThrow(RuntimeConfigError);
  });
});

describe("a dev build", () => {
  // No deploy writes config.json under vite dev, and its SPA fallback would
  // answer the path with index.html (ADR-0019).
  it("never fetches and keeps paths relative", async () => {
    const fetchFn = answering(200, CONFIG);
    const config = createRuntimeConfig(true, fetchFn);
    await config.load();
    expect(fetchFn).not.toHaveBeenCalled();
    expect(config.apiUrl("/api/me")).toBe("/api/me");
  });
});

describe("a production build", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches config.json once in the default cache mode, then prefixes every path", async () => {
    const fetchFn = answering(200, CONFIG);
    const config = createRuntimeConfig(false, fetchFn);
    await config.load();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [input, init] = fetchFn.mock.calls[0];
    expect(input).toBe("/config.json");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    // The preload in index.html is consumed only by a matching request.
    expect(init).not.toHaveProperty("cache");
    expect(config.apiUrl("/api/me")).toBe("https://api.example.test/api/me");
  });

  it("refuses to build a URL before the origin is loaded", () => {
    const config = createRuntimeConfig(false, answering(200, CONFIG));
    expect(() => config.apiUrl("/api/me")).toThrow(RuntimeConfigError);
  });

  it.each([
    ["a 404", answering(404, "")],
    ["a body that is not JSON", answering(200, "<!doctype html>")],
    ["a dead network", vi.fn<FetchFn>(() => Promise.reject(new TypeError("Failed to fetch")))],
  ])("rejects on %s", async (_, fetchFn) => {
    const config = createRuntimeConfig(false, fetchFn);
    await expect(config.load()).rejects.toBeInstanceOf(RuntimeConfigError);
  });

  it("fetches again after a failure", async () => {
    const fetchFn = vi
      .fn<FetchFn>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(new Response(CONFIG, { status: 200 }));
    const config = createRuntimeConfig(false, fetchFn);
    await expect(config.load()).rejects.toBeInstanceOf(RuntimeConfigError);
    await config.load();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(config.apiUrl("/api/me")).toBe("https://api.example.test/api/me");
  });

  it("times out a stalled fetch", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<FetchFn>(
      (_, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const config = createRuntimeConfig(false, fetchFn);
    const loading = config.load();
    const settled = expect(loading).rejects.toBeInstanceOf(RuntimeConfigError);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_SECONDS * 1000);
    await settled;
  });
});
