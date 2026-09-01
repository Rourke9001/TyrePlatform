import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { disposeTyre, receiveTyres, setTyreCost, fetchTyres } from "./tyres";
import { ApiError } from "./client";

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// setTyreCost and disposeTyre answer 204 (tyres.go): a body would violate the
// Response spec for that status, so the no-content success case gets its own
// constructor rather than reusing respond().
function respondNoContent(): Response {
  return new Response(null, { status: 204 });
}

// A POST body is a string per RequestInit#body; a guard that throws (rather
// than a cast, docs/lessons.md 2026-08-31) keeps this from vacuously passing
// against a Blob/FormData/URLSearchParams body.
function jsonBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("expected a JSON string body");
  return JSON.parse(init.body);
}

describe("the tyre register API module", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("fetchTyres", () => {
    it("reads the register with no filters and unwraps the envelope", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(200, {
          tyres: [
            {
              id: "t1",
              displayCode: "H1-POS1",
              state: "IN_SERVICE",
              status: "OK",
              retreadCount: 0,
              sizeName: "295/80R22.5",
              brandName: "Bridgestone",
              patternName: "R150",
              receivedDate: "2026-01-01",
              awaitingCost: false,
            },
          ],
        }),
      );

      const tyres = await fetchTyres();

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/tyres");
      expect(tyres).toHaveLength(1);
      expect(tyres[0].displayCode).toBe("H1-POS1");
    });

    it("narrows to the awaiting-cost backlog", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, { tyres: [] }));

      await fetchTyres({ awaitingCost: true });

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/tyres?awaitingCost=true");
    });

    it("omits awaitingCost from the query string when false", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, { tyres: [] }));

      await fetchTyres({ awaitingCost: false });

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/tyres");
    });

    it("resolves a display code as of a date", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, { tyres: [] }));

      await fetchTyres({ code: "H1-POS1", on: "2026-01-01" });

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/tyres?code=H1-POS1&on=2026-01-01");
    });

    it("combines a code lookup with the awaiting-cost filter", async () => {
      vi.mocked(fetch).mockResolvedValue(respond(200, { tyres: [] }));

      await fetchTyres({ code: "H1-POS1", on: "2026-01-01", awaitingCost: true });

      expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
        "/api/tyres?code=H1-POS1&on=2026-01-01&awaitingCost=true",
      );
    });

    it("carries a refusal's message and code", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(403, { code: "forbidden", message: "ManageAssets is required" }),
      );

      const error = await fetchTyres().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("forbidden");
      expect((error as ApiError).message).toBe("ManageAssets is required");
    });
  });

  describe("receiveTyres", () => {
    it("posts the intake body and unwraps the minted tyres", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(201, { tyres: [{ id: "t1", displayCode: "H1-POS1" }] }),
      );

      const received = await receiveTyres({ quantity: 1, sizeId: "s1" });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/tyres");
      expect(init?.method).toBe("POST");
      expect(jsonBody(init)).toEqual({ quantity: 1, sizeId: "s1" });
      expect(received).toEqual([{ id: "t1", displayCode: "H1-POS1" }]);
    });

    it("carries a display-code-taken refusal's message and code", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(409, {
          code: "display_code_taken",
          message: "an active tyre already carries that display code",
        }),
      );

      const error = await receiveTyres({ quantity: 1 }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("display_code_taken");
      expect((error as ApiError).message).toBe("an active tyre already carries that display code");
    });
  });

  describe("setTyreCost", () => {
    it("posts the cost under the tyre it belongs to and resolves with nothing", async () => {
      vi.mocked(fetch).mockResolvedValue(respondNoContent());

      const result = await setTyreCost("t1", { price: "1218.78", source: "INVOICE" });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/tyres/t1/cost");
      expect(init?.method).toBe("POST");
      expect(jsonBody(init)).toEqual({ price: "1218.78", source: "INVOICE" });
      expect(result).toBeUndefined();
    });

    it("carries TY011's message and code", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(409, { code: "TY011", message: "this tyre already carries a cost" }),
      );

      const error = await setTyreCost("t1", { price: "1218.78", source: "INVOICE" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("TY011");
      expect((error as ApiError).message).toBe("this tyre already carries a cost");
    });
  });

  describe("disposeTyre", () => {
    it("posts the disposal under the tyre it belongs to and resolves with nothing", async () => {
      vi.mocked(fetch).mockResolvedValue(respondNoContent());

      const result = await disposeTyre("t1", { disposal: "SCRAPPED", reason: "worn out" });

      const [url, init] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("/api/tyres/t1/dispose");
      expect(init?.method).toBe("POST");
      expect(jsonBody(init)).toEqual({ disposal: "SCRAPPED", reason: "worn out" });
      expect(result).toBeUndefined();
    });

    it("carries TY013's message and code", async () => {
      vi.mocked(fetch).mockResolvedValue(
        respond(409, { code: "TY013", message: "no such transition from this state" }),
      );

      const error = await disposeTyre("t1", { disposal: "SOLD", proceeds: "500.00" }).catch(
        (e: unknown) => e,
      );

      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("TY013");
      expect((error as ApiError).message).toBe("no such transition from this state");
    });
  });
});
