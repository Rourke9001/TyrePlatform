import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth/oidc", () => ({
  renew: vi.fn(),
  signIn: vi.fn(),
  completeSignIn: vi.fn(),
  signOut: vi.fn(),
}));

// A production build's API origin, as config.json names it (ADR-0019).
vi.mock("./runtimeConfig", () => ({
  apiUrl: (path: string) => `https://api.example.test${path}`,
}));

import { ApiError, apiGet } from "./client";

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn(() =>
    Promise.resolve({
      ok: status < 400,
      status,
      json: () =>
        body === undefined ? Promise.reject(new SyntaxError("empty")) : Promise.resolve(body),
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("the API origin", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefixes the path with the configured origin", async () => {
    const fetchMock = stubFetch(200, { ok: true });
    await apiGet("/api/me");
    expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/api/me", expect.anything());
  });

  it("names the relative path in a refusal with no envelope", async () => {
    stubFetch(404, undefined);
    const err = await apiGet("/api/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).message).toBe("GET /api/me failed: 404");
  });
});
