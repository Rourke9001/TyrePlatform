import { describe, expect, it } from "vitest";
import type { Vehicle } from "../api/vehicles";
import { searchVehicles } from "./vehicleSearch";

const v = (fleetNumber: string, registration: string | null): Vehicle => ({
  id: fleetNumber,
  fleetNumber,
  registration,
});

const fleet = [
  v("BAC10", "XYZ111GP"),
  v("BAC2", "ABC222GP"),
  v("BAC1", null),
  v("TRK7", "BAC333GP"),
];

describe("searchVehicles", () => {
  it("sorts fleet numbers naturally, not lexicographically (NFR-USE-012)", () => {
    expect(searchVehicles(fleet, "").map((x) => x.fleetNumber)).toEqual([
      "BAC1",
      "BAC2",
      "BAC10",
      "TRK7",
    ]);
  });

  it("matches fleet number case-insensitively", () => {
    expect(searchVehicles(fleet, "bac1").map((x) => x.fleetNumber)).toEqual(["BAC1", "BAC10"]);
  });

  it("matches registration too (FR-VEH-022)", () => {
    expect(searchVehicles(fleet, "333").map((x) => x.fleetNumber)).toEqual(["TRK7"]);
  });

  it("survives null registrations and whitespace queries", () => {
    expect(searchVehicles(fleet, "  ")).toHaveLength(4);
    expect(searchVehicles(fleet, "zzz")).toHaveLength(0);
  });
});
