import { describe, expect, it } from "vitest";

import { ApiError } from "../api/apiError";
import { failureOf } from "./actorContext";

describe("failureOf", () => {
  it("names the screen each refusal of /api/me needs", () => {
    expect(failureOf(new ApiError(401, "x", "unauthorized"))).toBe("signed-out");
    expect(failureOf(new ApiError(401, "x", "signed_out"))).toBe("signed-out");
    expect(failureOf(new ApiError(403, "x", "forbidden"))).toBe("not-set-up");
    expect(failureOf(new ApiError(403, "x", "not_provisioned"))).toBe("not-set-up");
    expect(failureOf(new ApiError(403, "x", "tenant_inactive"))).toBe("tenant-inactive");
    expect(failureOf(new ApiError(503, "x", "auth_unavailable"))).toBe("unavailable");
  });

  it("names nothing for any other error, or none", () => {
    expect(failureOf(new ApiError(500, "x", "internal"))).toBeNull();
    expect(failureOf(new TypeError("Failed to fetch"))).toBeNull();
    expect(failureOf(null)).toBeNull();
  });
});
