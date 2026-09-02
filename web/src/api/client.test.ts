import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, apiGet, apiPatch, apiPost } from "./client";

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

  // Pins apiPost's 204 handling — see client.ts's own comment for why.
  it("resolves with nothing on a 204, without trying to parse an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiPost("/api/tyres/t1/cost", {})).resolves.toBeUndefined();
  });
});

describe("apiPatch", () => {
  const DEV_TENANT_STORAGE_KEY = "tyre.dev.tenant-id";
  const DEV_ACTOR_STORAGE_KEY = "tyre.dev.user-id";

  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    window.localStorage.removeItem(DEV_TENANT_STORAGE_KEY);
    window.localStorage.removeItem(DEV_ACTOR_STORAGE_KEY);
  });

  // The unit PATCH answers with the same body the unit read does (D6), so
  // this pins method, body and the dev actor/tenant headers apiGet and
  // apiPost already carry — the one thing genuinely new about apiPatch.
  it("sends PATCH with the JSON body and the dev headers", async () => {
    const devTenantId = "11111111-1111-1111-1111-111111111111";
    const devActorId = "b85aef08-6081-80db-9d4d-dad38ae40545";
    window.localStorage.setItem(DEV_TENANT_STORAGE_KEY, devTenantId);
    window.localStorage.setItem(DEV_ACTOR_STORAGE_KEY, devActorId);
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ id: "v1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const result = await apiPatch<{ id: string }>("/api/vehicles/v1", { fleetNumber: "H1" });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("/api/vehicles/v1");
    expect(init?.method).toBe("PATCH");
    expect(typeof init?.body).toBe("string");
    expect(JSON.parse(init?.body as string)).toEqual({ fleetNumber: "H1" });
    expect(new Headers(init?.headers).get("X-Tenant-ID")).toBe(devTenantId);
    expect(new Headers(init?.headers).get("X-User-ID")).toBe(devActorId);
    expect(result).toEqual({ id: "v1" });
  });

  // Mirrors apiPost's 204 handling (client.ts's own comment): the descriptive
  // edit is not the only write behind apiPatch forever, and a future no-body
  // 204 must not turn into a thrown SyntaxError either.
  it("resolves with nothing on a 204, without trying to parse an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiPatch("/api/vehicles/v1", {})).resolves.toBeUndefined();
  });

  it("throws an ApiError carrying the envelope's code and message", async () => {
    stubFetch(422, { code: "invalid_submission", message: "fleetNumber may not be blank" });

    const error = await apiPatch("/api/vehicles/v1", { fleetNumber: "" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_submission");
    expect((error as ApiError).message).toBe("fleetNumber may not be blank");
  });
});
