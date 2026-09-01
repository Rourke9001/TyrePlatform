import { beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiGet, apiPost } from "./client";

function stubFetch(status: number, body: unknown, ok = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok,
        status,
        json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
      }),
    ),
  );
}

describe("the refusal envelope", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries the code off a refusal", async () => {
    stubFetch(409, {
      code: "TY003",
      message: "a unit in this submit was already inspected within 6 hours",
    });

    const err = await apiPost("/api/inspections", {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe("TY003");
  });

  it("distinguishes a conflict from the duplicate window", async () => {
    stubFetch(409, {
      code: "conflict",
      message: "the submission conflicts with data already recorded",
    });

    const err = (await apiPost("/api/inspections", {}).catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(409);
    expect(err.code).toBe("conflict");
  });

  // A proxy or gateway refusal carries no envelope. An error path that throws
  // while reporting an error is the one failure the outbox cannot absorb.
  it("reads a body with no envelope as a null code", async () => {
    stubFetch(502, { nothing: "useful" });

    const err = (await apiGet("/api/me").catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(502);
    expect(err.code).toBeNull();
  });

  it("reads an unparseable body as a null code", async () => {
    stubFetch(500, new SyntaxError("Unexpected token < in JSON"));

    const err = (await apiGet("/api/me").catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(500);
    expect(err.code).toBeNull();
  });

  it("reads a non-string code as null rather than trusting it", async () => {
    stubFetch(422, { code: 42 });

    const err = (await apiGet("/api/me").catch((e: unknown) => e)) as ApiError;

    expect(err.code).toBeNull();
  });

  it("carries the envelope's own message, which is the server's to write", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "fleet_number_taken",
          message: "a unit with that fleet number already exists",
        }),
        {
          status: 409,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const error = await apiPost("/api/vehicles", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe("a unit with that fleet number already exists");
    expect((error as ApiError).code).toBe("fleet_number_taken");
  });

  it("falls back to a diagnostic message when the refusal carried no envelope", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
    const error = await apiPost("/api/vehicles", {}).catch((e: unknown) => e);
    expect((error as ApiError).code).toBeNull();
    expect((error as ApiError).message).toContain("502");
  });

  // The tyre lifecycle's cost/dispose steps (api/internal/httpapi/tyres.go)
  // are the API's first 204 responses. A 204 body is empty by spec, and
  // Response#json() rejects on an empty stream — without this case, a
  // successful write throws a SyntaxError that looks like a transport
  // failure rather than resolving.
  it("resolves with nothing on a 204, without trying to parse an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiPost("/api/tyres/t1/cost", {})).resolves.toBeUndefined();
  });
});
