import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth/oidc", () => ({
  renew: vi.fn(),
  signIn: vi.fn(),
  completeSignIn: vi.fn(),
  signOut: vi.fn(),
}));

import { AUTH_HEADER, ApiError, apiGet, apiPatch, apiPost } from "./client";
import { REQUEST_TIMEOUT_SECONDS } from "./deadline";
import { clearDevActorId, clearDevTenantId, setDevActorId, setDevTenantId } from "./devTenant";
import { sentBody } from "../test/fixtures";
import { bearerSession } from "../test/bearerSession";

function stubFetch(status: number, body: unknown, ok = false) {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok,
        status,
        json: () => (body instanceof Error ? Promise.reject(body) : Promise.resolve(body)),
        // send() reads a refusal as text: a SyntaxError stands for a body
        // that arrived and does not parse, any other Error for one lost.
        text: () =>
          body instanceof SyntaxError
            ? Promise.resolve("<html>")
            : body instanceof Error
              ? Promise.reject(body)
              : Promise.resolve(JSON.stringify(body)),
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

  // A refusal's code decides whether the outbox retries it (outbox.ts
  // classify), so a body lost in transit is offline, not the bare status.
  it("rejects as offline when a refusal's body is lost in transit", async () => {
    stubFetch(403, new TypeError("network error"));

    const err = await apiPost("/api/inspections", {}).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ApiError);
  });

  // Nothing reads a 401's code (failureOf, classify), so its body is not
  // waited for: "Sign in to send" shows on this attempt, not the next.
  it("reads a 401 whose body is lost as a 401", async () => {
    stubFetch(401, new TypeError("network error"));

    const err = (await apiGet("/api/me").catch((e: unknown) => e)) as ApiError;

    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(401);
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

  // Pins apiPost's 204 handling. See client.ts's own comment for why.
  it("resolves with nothing on a 204, without trying to parse an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));
    await expect(apiPost("/api/tyres/t1/cost", {})).resolves.toBeUndefined();
  });
});

describe("apiPatch", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    clearDevTenantId();
    clearDevActorId();
  });

  // The unit PATCH answers with the same body the unit read does (D6), so
  // this pins method, body and the dev actor/tenant headers apiGet and
  // apiPost already carry. That is the one thing genuinely new about apiPatch.
  it("sends PATCH with the JSON body and the dev headers", async () => {
    const devTenantId = "11111111-1111-1111-1111-111111111111";
    const devActorId = "b85aef08-6081-80db-9d4d-dad38ae40545";
    setDevTenantId(devTenantId);
    setDevActorId(devActorId);
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
    expect(sentBody(0)).toEqual({ fleetNumber: "H1" });
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

describe("the bearer path", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
    bearerSession();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    window.localStorage.clear();
  });

  function mirror(obtainedAt: number) {
    window.localStorage.setItem(
      "tyre.auth.mirror",
      JSON.stringify({
        accessToken: "at-1",
        expiresAt: Date.now() + 3_600_000,
        obtainedAt,
        subject: "oid-a",
        tenantId: null,
      }),
    );
  }

  // The latch is module state (token.ts), so each case loads its own graph.
  async function freshClient() {
    vi.resetModules();
    return import("./client");
  }

  it("attaches the bearer and no dev header", async () => {
    const { apiGet: get } = await freshClient();
    mirror(Date.now() - 5 * 60_000);
    window.localStorage.setItem("tyre.dev.user-id", "dev-actor");
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await get("/api/me");

    const headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
    expect(AUTH_HEADER).toBe("Authorization");
    expect(headers.get("Authorization")).toBe("Bearer at-1");
    expect(headers.get("X-User-ID")).toBeNull();
  });

  // U104: the outbox sends under the credential it compared the stamp against.
  it("sends apiPostAs under the given token, not the mirror's", async () => {
    const { apiPostAs: post } = await freshClient();
    mirror(Date.now() - 5 * 60_000);
    vi.stubGlobal("fetch", vi.fn());
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    await post("/api/inspections", {}, { accessToken: "at-other", subject: "oid-b" });

    const headers = new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers);
    expect(headers.get("Authorization")).toBe("Bearer at-other");
  });

  // Spec section 4, A fresh token refused: a latch set after the caller took
  // its credential must still stop the send.
  it("refuses apiPostAs without fetching once the store has latched", async () => {
    const { apiGet: get, apiPostAs: post } = await freshClient();
    mirror(Date.now());
    stubFetch(401, { code: "unauthorized", message: "x" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await get("/api/me").catch((e: unknown) => e);
    vi.mocked(fetch).mockClear();

    const err = (await post(
      "/api/inspections",
      {},
      { accessToken: "at-1", subject: "oid-a" },
    ).catch((e: unknown) => e)) as ApiError;

    expect(err.status).toBe(503);
    expect(err.code).toBe("auth_unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears the mirror on a 401 for an older token, and the refusal stays a 401", async () => {
    const { apiGet: get, ApiError: Err } = await freshClient();
    mirror(Date.now() - 5 * 60_000);
    stubFetch(401, { code: "unauthorized", message: "the request does not identify a user" });

    const err = await get("/api/me").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Err);
    expect((err as InstanceType<typeof Err>).status).toBe(401);
    expect(window.localStorage.getItem("tyre.auth.mirror")).toBeNull();
  });

  // Spec section 4: a misconfigured API must read "unavailable", never send
  // the driver to a sign-in that cannot help.
  it("turns a 401 on a token obtained seconds ago into 503, and then stops calling the API", async () => {
    const { apiGet: get } = await freshClient();
    mirror(Date.now());
    stubFetch(401, { code: "unauthorized", message: "x" });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const first = (await get("/api/me").catch((e: unknown) => e)) as ApiError;
    const second = (await get("/api/me").catch((e: unknown) => e)) as ApiError;

    expect(first.status).toBe(503);
    expect(first.code).toBe("auth_unavailable");
    expect(second.status).toBe(503);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

// TYRE-389: a request that stalls, in its headers or its body, reads as
// offline once the bound passes, so the outbox holds the entry and retries it.
describe("the request bound", () => {
  const PENDING = Symbol("pending");

  beforeEach(() => {
    vi.unstubAllGlobals();
    // Only the timer the bound uses: nothing here touches IndexedDB.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function afterTheBound(call: Promise<unknown>): Promise<unknown> {
    const settled = call.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_SECONDS * 1000);
    return Promise.race([settled, Promise.resolve(PENDING)]);
  }

  function stallingBody(status: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: status < 400,
          status,
          json: () => new Promise(() => undefined),
          text: () => new Promise(() => undefined),
        }),
      ),
    );
  }

  it("rejects as offline when a success's body never arrives", async () => {
    stallingBody(201);

    const result = await afterTheBound(apiPost("/api/inspections", {}));

    expect(result).not.toBe(PENDING);
    expect(result).toBeInstanceOf(Error);
    expect(result).not.toBeInstanceOf(ApiError);
  });

  // A refusal's code decides whether the outbox retries (outbox.ts classify),
  // so a refusal whose body stalls is not read as the bare status.
  it("rejects as offline when a refusal's body never arrives", async () => {
    stallingBody(403);

    const result = await afterTheBound(apiPost("/api/inspections", {}));

    expect(result).not.toBe(PENDING);
    expect(result).not.toBeInstanceOf(ApiError);
  });

  it("aborts a request whose response never starts", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            signal = init.signal ?? undefined;
            signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );

    const result = await afterTheBound(apiGet("/api/me"));

    expect(result).not.toBe(PENDING);
    expect(result).not.toBeInstanceOf(ApiError);
    expect(signal?.aborted).toBe(true);
  });

  it("leaves a request that finished in time alone", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        signal = init.signal ?? undefined;
        return Promise.resolve(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
      }),
    );

    const result = await afterTheBound(apiGet("/api/me"));

    expect(result).toEqual({ ok: 1 });
    expect(signal?.aborted).toBe(false);
  });
});
