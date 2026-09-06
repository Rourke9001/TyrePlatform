import { describe, expect, it, vi } from "vitest";

import type { Draft, DraftPosition } from "./draft";
import { cellKey } from "./draft";
import { absentCells, deviceId, halfEnteredCell, toSubmitPayload } from "./payload";

// Fills in the DraftPosition/Draft fields a halfEnteredCell test does not
// care about, so each case states only what it is testing (treads,
// pressureKpa) and stays legible against the predicate it exercises.
function draftWith(
  positions: Pick<DraftPosition, "positionId" | "vehicleId" | "treads" | "pressureKpa">[],
): Draft {
  return {
    clientUuid: "u",
    vehicleId: "v1",
    fleetNumber: null,
    combinationId: null,
    observedMemberVehicleIds: [],
    taskId: null,
    startedAt: "2026-09-06T08:00:00Z",
    odometerKm: null,
    comment: null,
    defectReport: null,
    positions: Object.fromEntries(
      positions.map((p) => [
        cellKey(p.vehicleId, p.positionId),
        {
          ...p,
          tyreId: null,
          pressureTemperature: "UNKNOWN",
          damageFlag: false,
          note: null,
          seconds: 0,
          warnings: [],
        } satisfies DraftPosition,
      ]),
    ),
    warnings: [],
    absentSpares: [],
  };
}

const meta = {
  submittedAt: "2026-08-25T06:14:40Z",
  // Not 1.0: that is also the value a hardcoded literal in the builder would
  // produce, so a passthrough and a constant would be indistinguishable. 0.5
  // is a legal granularity (000023_submit_inspection.up.sql accepts 1.0, 0.5
  // and 0.1) that only a real passthrough can produce.
  granularityMm: 0.5,
  deviceId: "device-1",
  appVersion: "0.0.0",
  totalPositions: 4,
};

const draft: Draft = {
  clientUuid: "0f8f0f8f-0f8f-0f8f-0f8f-0f8f0f8f0f8f",
  vehicleId: "v-horse",
  fleetNumber: "BAC039SP",
  combinationId: "c1",
  observedMemberVehicleIds: ["v-horse", "v-link6"],
  taskId: "task-1",
  startedAt: "2026-08-25T06:12:00Z",
  odometerKm: 412500,
  comment: "7/8 need replacing",
  defectReport: null,
  positions: {
    p1: {
      positionId: "p1",
      vehicleId: "v-horse",
      tyreId: "ty1",
      treads: [13, 11, 14],
      pressureKpa: 800,
      pressureTemperature: "COLD",
      damageFlag: false,
      note: null,
      seconds: 6,
      warnings: [{ code: "FR-INS-041", enteredValue: "3", response: "ACKNOWLEDGED" }],
    },
    p2: {
      positionId: "p2",
      // A trailer position: owned by the towed unit, not the motive vehicle.
      vehicleId: "v-link6",
      tyreId: null,
      treads: [9, 9, 10],
      pressureKpa: 750,
      pressureTemperature: "UNKNOWN",
      damageFlag: true,
      note: "sidewall scuff",
      seconds: 5,
      warnings: [],
    },
  },
  warnings: [{ code: "FR-INS-033", enteredValue: "412500", response: "CONFIRMED" }],
  absentSpares: [],
};

describe("toSubmitPayload", () => {
  it("carries the header the server needs to place the inspection", () => {
    const p = toSubmitPayload(draft, meta);
    expect(p.client_uuid).toBe(draft.clientUuid);
    expect(p.vehicle_id).toBe("v-horse");
    expect(p.combination_id).toBe("c1");
    expect(p.task_id).toBe("task-1");
    expect(p.started_at).toBe("2026-08-25T06:12:00Z");
    expect(p.submitted_at).toBe(meta.submittedAt);
    expect(p.odometer_km).toBe(412500);
  });

  // THE assertion of this slice. FR-INS-029a maps entry order to
  // OUTER/CENTRE/INNER by side, on the server. Reorder, sort or reverse here
  // and every reading on one side of every vehicle is silently mislabelled.
  it("sends the treads in entry order, untouched", () => {
    const p = toSubmitPayload(draft, meta);
    const first = p.readings.find((r) => r.position_id === "p1");
    expect(first?.treads).toEqual([13, 11, 14]);
  });

  // CR-011 / DR-017 / TY006: the client sends measurements, the trigger
  // derives the minimum. Asserting it here would be rejected outright, and
  // rightly — two implementations of one rule is how they drift.
  it("never asserts a governing tread", () => {
    const p = toSubmitPayload(draft, meta);
    const raw = JSON.stringify(p);
    expect(raw).not.toContain("governing");
  });

  // BR-VEH-003 as amended by E2: rig numbers are a display projection,
  // computed at render time, never stored and never transmitted.
  it("transmits no rig-level position number", () => {
    const p = toSubmitPayload(draft, meta);
    for (const r of p.readings) {
      expect(r).not.toHaveProperty("sequence");
      expect(r).not.toHaveProperty("rig_position");
    }
  });

  // FR-INS-061: the owning unit, which for a trailer position is not the
  // inspection's motive vehicle.
  it("attributes each reading to the unit that owns the position", () => {
    const p = toSubmitPayload(draft, meta);
    expect(p.readings.find((r) => r.position_id === "p2")?.vehicle_id).toBe("v-link6");
  });

  // FR-INS-021: the granularity in force is stamped onto every reading.
  it("stamps the capture granularity on every reading", () => {
    const p = toSubmitPayload(draft, meta);
    expect(p.readings.every((r) => r.granularity_mm === 0.5)).toBe(true);
  });

  // NFR-OBS-007 and FR-INS-040: both ride in the payload or they do not exist.
  it("carries per-position seconds and every warning with its response", () => {
    const p = toSubmitPayload(draft, meta);
    const first = p.readings.find((r) => r.position_id === "p1");
    expect(first?.seconds).toBe(6);
    expect(first?.warnings[0]).toEqual({
      code: "FR-INS-041",
      entered_value: "3",
      response: "ACKNOWLEDGED",
    });
    expect(p.warnings[0].code).toBe("FR-INS-033");
  });

  it("computes the duration from the two timestamps", () => {
    expect(toSubmitPayload(draft, meta).duration_seconds).toBe(160);
  });

  // A partial inspection must say so. The column defaults to 100, so an
  // omitted value is not 'unknown' — it is a false claim of completeness.
  it("reports completeness against every position, not just the ones captured", () => {
    expect(toSubmitPayload(draft, meta).completeness_pct).toBe(50);
  });

  it("carries the driver's own words and the device that recorded them", () => {
    const p = toSubmitPayload({ ...draft, defectReport: "brake light out" }, meta);
    expect(p.comment).toBe("7/8 need replacing");
    expect(p.defect_report).toBe("brake light out");
    // Distinct values on purpose: a device_id/app_version swap type-checks.
    expect(p.device_id).toBe("device-1");
    expect(p.app_version).toBe("0.0.0");
    expect(toSubmitPayload(draft, meta).defect_report).toBeNull();
  });

  // FR-INS-062/063: what the driver said was attached. The server records a
  // difference from the recorded composition; it does not create one.
  it("carries the observed composition", () => {
    expect(toSubmitPayload(draft, meta).observed_member_vehicle_ids).toEqual([
      "v-horse",
      "v-link6",
    ]);
  });

  // FR-INS-020: optional, and a trailer-only inspection has no field at all.
  it("omits the odometer where there is none", () => {
    const trailerOnly = { ...draft, odometerKm: null };
    expect(toSubmitPayload(trailerOnly, meta).odometer_km).toBeNull();
  });

  // Positions are a keyed object in the draft so an entry overwrites cleanly;
  // the payload is an array, and its order must not depend on object key
  // iteration. NFR-USE-012 asks for natural order everywhere it is visible.
  // FR-OFF-005 persists per keystroke, so the draft legitimately holds
  // half-entered positions. They are not readings.
  it("omits a position that was started and not finished", () => {
    const partial: Draft = {
      ...draft,
      positions: {
        ...draft.positions,
        p3: {
          positionId: "p3",
          vehicleId: "v-horse",
          tyreId: null,
          treads: [12, null, null],
          pressureKpa: null,
          pressureTemperature: "UNKNOWN",
          damageFlag: false,
          note: null,
          seconds: 2,
          warnings: [],
        },
      },
    };
    const p = toSubmitPayload(partial, meta);
    expect(p.readings.map((r) => r.position_id)).toEqual(["p1", "p2"]);
    expect(p.completeness_pct).toBe(50);
  });

  it("keeps a zero duration, which the column allows", () => {
    const instant = { ...meta, submittedAt: draft.startedAt };
    expect(toSubmitPayload(draft, instant).duration_seconds).toBe(0);
  });

  // A backwards clock step would otherwise fail the >= 0 CHECK and be refused
  // permanently. Null, not 0: this column feeds NFR-USE-001's median.
  it("records no duration when the device clock moved backwards", () => {
    const skewed = { ...meta, submittedAt: "2026-08-25T06:11:00Z" };
    expect(toSubmitPayload(draft, skewed).duration_seconds).toBeNull();
  });

  it("never claims more than complete when the position count is stale", () => {
    expect(toSubmitPayload(draft, { ...meta, totalPositions: 1 }).completeness_pct).toBe(100);
  });

  it("reports nothing complete when there is no count to measure against", () => {
    expect(toSubmitPayload(draft, { ...meta, totalPositions: 0 }).completeness_pct).toBe(0);
  });

  // Keyed p2-then-p1 on purpose: Object.values returns insertion order, so a
  // fixture in ascending order would pass with the sort removed.
  it("orders readings by position id, not by the order the driver walked", () => {
    const walked: Draft = {
      ...draft,
      positions: { p2: draft.positions.p2, p1: draft.positions.p1 },
    };
    expect(toSubmitPayload(walked, meta).readings.map((r) => r.position_id)).toEqual(["p1", "p2"]);
  });

  // 000023 accepts a NULL pressure deliberately. The draft is cleared on
  // submit, so filtering this out would destroy three good tread readings.
  // A rig's two member units of one axle configuration carry the SAME position
  // ids, so the position alone cannot separate that couple. A stable sort left
  // to itself settles the tie by insertion order — the order the driver
  // happened to walk the rig — which is precisely what a deterministic payload
  // must not depend on.
  it("orders a shared position id the same way whichever unit was walked first", () => {
    const cell = (vehicleId: string): DraftPosition => ({
      positionId: "p1",
      vehicleId,
      tyreId: null,
      treads: [10, 10, 11],
      pressureKpa: 750,
      pressureTemperature: "UNKNOWN",
      damageFlag: false,
      note: null,
      seconds: 4,
      warnings: [],
    });
    const walked = (first: string, second: string): Draft => ({
      ...draft,
      positions: {
        [cellKey(first, "p1")]: cell(first),
        [cellKey(second, "p1")]: cell(second),
      },
    });
    const order = (d: Draft) =>
      toSubmitPayload(d, meta).readings.map((r) => cellKey(r.vehicle_id, r.position_id));

    expect(order(walked("v-horse", "v-link6"))).toEqual(["v-horse:p1", "v-link6:p1"]);
    // The same rig walked the other way round. Without the tie-break this
    // returns the two the other way and the assertion above still passes.
    expect(order(walked("v-link6", "v-horse"))).toEqual(["v-horse:p1", "v-link6:p1"]);
  });

  it("sends a position whose treads are complete but whose pressure was never taken", () => {
    const noPressure: Draft = {
      ...draft,
      positions: {
        ...draft.positions,
        p4: {
          positionId: "p4",
          vehicleId: "v-horse",
          tyreId: null,
          treads: [10, 10, 11],
          pressureKpa: null,
          pressureTemperature: "UNKNOWN",
          damageFlag: false,
          note: null,
          seconds: 4,
          warnings: [],
        },
      },
    };
    const p = toSubmitPayload(noPressure, meta);
    expect(p.readings.map((r) => r.position_id)).toEqual(["p1", "p2", "p4"]);
    expect(p.readings.find((r) => r.position_id === "p4")?.pressure_kpa).toBeNull();
    expect(p.completeness_pct).toBe(75);
  });

  // The server records the observation (000041); a key the server ignored
  // would be the silent drop the design spec forbids, so the payload carries
  // exactly what submit_inspection reads, and the absent cell comes off the
  // denominator here the same way it does on screen.
  it("carries absent spares by unit and position and takes them off the denominator", () => {
    const d = {
      ...draftWith([{ positionId: "p1", vehicleId: "v1", treads: [12, 13, 14], pressureKpa: 800 }]),
      absentSpares: [{ vehicleId: "v1", positionId: "s1" }],
    };
    const payload = toSubmitPayload(d, { ...meta, totalPositions: 1 });
    expect(payload.absent_spares).toEqual([{ vehicle_id: "v1", position_id: "s1" }]);
    expect(payload.completeness_pct).toBe(100);
    expect(absentCells(d)).toEqual(new Set(["v1:s1"]));
  });

  // TYRE-155: submit_inspection refuses TY005 outright when one cell carries
  // both a reading and an absent_spares entry, and the outbox treats that
  // 422 as permanent — so this must be unreachable from the payload side
  // too. draft.ts's markSpareAbsent discards the position the same
  // transaction it records the mark in, so a draft that carries an absent
  // spare never has a position for that cell to begin with; this pins the
  // payload the flow actually sends reflects that, not a filter here.
  it("carries no reading for a cell the draft records as an absent spare", () => {
    const d = {
      ...draftWith([{ positionId: "p1", vehicleId: "v1", treads: [12, 13, 14], pressureKpa: 800 }]),
      absentSpares: [{ vehicleId: "v1", positionId: "s1" }],
    };
    const payload = toSubmitPayload(d, meta);
    expect(payload.readings.some((r) => r.position_id === "s1")).toBe(false);
    expect(payload.absent_spares).toEqual([{ vehicle_id: "v1", position_id: "s1" }]);
  });
});

describe("deviceId", () => {
  it("keeps one device id across calls", () => {
    window.localStorage.clear();
    const first = deviceId();
    // Without this the test passes vacuously if storage throws in this
    // environment: both calls would return "unknown" and match each other.
    expect(first).not.toBe("unknown");
    expect(deviceId()).toBe(first);
  });

  it("submits unattributed rather than failing when storage is unavailable", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("private mode");
    });
    try {
      expect(deviceId()).toBe("unknown");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("halfEnteredCell", () => {
  // Only a position with SOME treads and not all is half-entered. Treads done
  // with no pressure is finished by the flow's own definition (pressure is
  // deliberately optional), so resume must not reopen it on every reload.
  it("finds the one position a driver was interrupted in", () => {
    const d = draftWith([
      { positionId: "p1", vehicleId: "v1", treads: [12, 13, 14], pressureKpa: null },
      { positionId: "p2", vehicleId: "v1", treads: [9, null, null], pressureKpa: null },
    ]);
    expect(halfEnteredCell(d)).toBe("v1:p2");
  });

  it("finds nothing when every position is untouched or finished", () => {
    const d = draftWith([
      { positionId: "p1", vehicleId: "v1", treads: [12, 13, 14], pressureKpa: 800 },
      { positionId: "p2", vehicleId: "v1", treads: [null, null, null], pressureKpa: null },
    ]);
    expect(halfEnteredCell(d)).toBeNull();
  });

  // The focus key can jump straight to the pressure field before every tread
  // is filled (entry.ts's "focus"), so a half-entered position can carry a
  // pressure reading too. Coupling the predicate to pressureKpa === null
  // would miss exactly this driver.
  it("still finds a half-entered position whose pressure was taken early", () => {
    const d = draftWith([
      { positionId: "p1", vehicleId: "v1", treads: [9, null, null], pressureKpa: 800 },
    ]);
    expect(halfEnteredCell(d)).toBe("v1:p1");
  });
});
