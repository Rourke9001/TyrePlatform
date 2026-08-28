import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { assignDriver, createUnit, createUser, fetchAxleConfigurations } from "./admin";
import { ApiError } from "./client";

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("the admin API module", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the configuration library", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(200, [{ id: "c1", code: "HORSE_6X4", name: "Horse", version: 1, axleCount: 3 }]),
    );
    const configs = await fetchAxleConfigurations();
    expect(configs[0].code).toBe("HORSE_6X4");
  });

  it("surfaces the refusal code so a form can branch on the reason", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(409, {
        code: "fleet_number_taken",
        message: "a unit with that fleet number already exists",
      }),
    );
    await expect(
      createUnit({ fleetNumber: "H1", configurationId: "c1", unitKind: "HORSE" }),
    ).rejects.toMatchObject({ code: "fleet_number_taken" });
  });

  it("carries a validation refusal's own message, which is ours to render", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(422, { code: "invalid_submission", message: "fleetNumber is required" }),
    );
    const error = await createUnit({
      fleetNumber: "",
      configurationId: "c1",
      unitKind: "HORSE",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_submission");
  });

  it("posts an assignment under the unit it belongs to", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(201, { id: "a1", vehicleId: "v1", userId: "u1", fromDate: "2026-01-01" }),
    );
    await assignDriver("v1", { userId: "u1", fromDate: "2026-01-01" });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/vehicles/v1/drivers");
  });

  it("creates a user", async () => {
    vi.mocked(fetch).mockResolvedValue(
      respond(201, {
        id: "u1",
        email: "a@example.invalid",
        displayName: "A",
        role: "DRIVER",
        staffNumber: null,
        active: true,
      }),
    );
    const created = await createUser({
      email: "a@example.invalid",
      displayName: "A",
      role: "DRIVER",
    });
    expect(created.active).toBe(true);
  });
});
