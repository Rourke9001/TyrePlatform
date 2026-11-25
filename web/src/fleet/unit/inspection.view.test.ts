import { describe, expect, it } from "vitest";

import {
  inspectionMark,
  inspectionRows,
  odometerCell,
  pressureText,
  readingCells,
  voidedText,
  warningValueText,
} from "./inspection.view";
import type { InspectionReading, InspectionWarning } from "../../api/inspections";
import { inspectionDetail, inspectionReading, unitInspection } from "../../test/fixtures";

const UNITS = { pressure: "kPa", distance: "km" };

describe("odometerCell", () => {
  it("gives this unit's own reading, marking one the odometer record refused", () => {
    expect(odometerCell(unitInspection({ inspectionId: "i1", odometerKm: 412300 }), "km")).toBe(
      "412,300 km",
    );
    expect(
      odometerCell(
        unitInspection({ inspectionId: "i1", odometerKm: 412300, odometerOnRecord: false }),
        "km",
      ),
    ).toBe("412,300 km (not on the odometer record)");
    expect(
      odometerCell(
        unitInspection({ inspectionId: "i1", odometerKm: null, odometerOnRecord: null }),
        "km",
      ),
    ).toBe("Not recorded");
  });

  // U249: a towed unit's row names the unit it was read with; never a distance.
  it("names the addressed unit on a towed unit's row, alone when its reading is not given", () => {
    const towed = unitInspection({
      inspectionId: "i1",
      addressedHere: false,
      addressedUnit: { fleetNumber: "H12", vehicleId: "h12" },
      odometerKm: 412300,
    });
    expect(odometerCell(towed, "km")).toBe("H12: 412,300 km");
    expect(
      odometerCell(
        { ...towed, addressedUnit: { fleetNumber: "H12", vehicleId: null }, odometerKm: null },
        "km",
      ),
    ).toBe("H12");
  });
});

describe("inspectionMark and voidedText", () => {
  it("marks a voided inspection voided even where it was the latest", () => {
    expect(inspectionMark(unitInspection({ inspectionId: "i1", latest: true }))).toBe("latest");
    expect(
      inspectionMark(unitInspection({ inspectionId: "i1", latest: true, state: "VOIDED" })),
    ).toBe("voided");
    expect(inspectionMark(unitInspection({ inspectionId: "i1", latest: false }))).toBeNull();
  });

  it("says who voided it, when and why", () => {
    const row = unitInspection({
      inspectionId: "i1",
      state: "VOIDED",
      voidedBy: "Nomsa",
      voidReason: "wrong rig",
    });
    expect(voidedText(row, "24 Nov 2026 10:05")).toBe(
      "Voided by Nomsa on 24 Nov 2026 10:05. Reason: wrong rig.",
    );
    expect(voidedText({ ...row, voidedBy: null }, "24 Nov 2026 10:05")).toBe(
      "Voided on 24 Nov 2026 10:05. Reason: wrong rig.",
    );
  });
});

describe("readingCells", () => {
  // Two readings at the minimum; the index is the wire's.
  it("names the cells when the stored anatomy is the order the side draws", () => {
    const left = inspectionReading({
      positionId: "p1",
      side: "LEFT",
      treadsMm: [5, 4, 4],
      treadAnatomy: ["OUTER", "CENTRE", "INNER"],
      orientationKnown: true,
      governingIndex: 1,
    });
    expect(readingCells(left)).toEqual({
      readings: ["5.0", "4.0", "4.0"],
      unitText: "mm",
      governingIndex: 1,
      naming: "named",
      side: "left",
    });
    const right = { ...left, side: "RIGHT", treadAnatomy: ["INNER", "CENTRE", "OUTER"] };
    expect(readingCells(right)).toMatchObject({ naming: "named", side: "right" });
  });

  it("numbers the cells when a name could not be the stored one", () => {
    const base = inspectionReading({
      positionId: "p1",
      side: "LEFT",
      treadsMm: [5, 4, 4],
      treadAnatomy: ["OUTER", "CENTRE", "INNER"],
      orientationKnown: true,
      governingIndex: 1,
    });
    expect(readingCells({ ...base, treadAnatomy: ["INNER", "CENTRE", "OUTER"] }).naming).toBe(
      "numbered",
    );
    expect(readingCells({ ...base, orientationKnown: false }).naming).toBe("numbered");
    const spare: InspectionReading = { ...base, side: null, isSpare: true };
    expect(readingCells(spare).naming).toBe("numbered");
    expect(
      readingCells({
        ...base,
        treadsMm: [5, 4],
        treadAnatomy: ["OUTER", "INNER"],
        governingIndex: 1,
      }).naming,
    ).toBe("numbered");
  });

  // No tread entered draws no cells.
  it("gives no cells and no governing index for a reading with no tread", () => {
    const none = inspectionReading({
      positionId: "p1",
      treadsMm: [],
      treadAnatomy: [],
      governingTreadMm: null,
      governingIndex: null,
      orientationKnown: null,
    });
    expect(readingCells(none)).toMatchObject({ readings: [], governingIndex: null });
  });
});

describe("pressureText", () => {
  it("sets the pressure beside the day's target with its basis", () => {
    expect(
      pressureText(
        inspectionReading({
          positionId: "p1",
          pressureKpa: 780,
          targetKpa: 800,
          pressureBasis: "COLD",
        }),
        "kPa",
      ),
    ).toBe("780 of 800 kPa, cold");
  });

  it("says a spare has no target, and a running position with none has none set", () => {
    expect(
      pressureText(
        inspectionReading({
          positionId: "p1",
          isSpare: true,
          pressureKpa: 780,
          targetKpa: null,
          pressureBasis: "COLD",
        }),
        "kPa",
      ),
    ).toBe("780 kPa, cold, no target for a spare");
    expect(
      pressureText(
        inspectionReading({
          positionId: "p1",
          pressureKpa: 780,
          targetKpa: null,
          pressureBasis: "UNKNOWN",
        }),
        "kPa",
      ),
    ).toBe("780 kPa, basis unknown, no target set");
  });

  it("says when no pressure was entered", () => {
    expect(pressureText(inspectionReading({ positionId: "p1", pressureKpa: null }), "kPa")).toBe(
      "Not entered",
    );
  });
});

describe("inspectionRows", () => {
  it("interleaves readings and spares reported absent in natural order", () => {
    const rows = inspectionRows(
      inspectionDetail({
        readings: [
          inspectionReading({ positionId: "p10", positionCode: "10" }),
          inspectionReading({ positionId: "p1", positionCode: "1" }),
        ],
        absentSpares: [
          { positionId: "pS", positionCode: "S" },
          { positionId: "p2", positionCode: "2" },
        ],
      }),
    );
    expect(
      rows.map((r) => (r.kind === "reading" ? r.reading.positionCode : r.spare.positionCode)),
    ).toEqual(["1", "2", "10", "S"]);
    expect(rows.map((r) => r.kind)).toEqual(["reading", "absent", "reading", "absent"]);
  });
});

describe("warningValueText", () => {
  function warning(code: string, enteredValue: string | null): InspectionWarning {
    return {
      code,
      source: "CLIENT",
      enteredValue,
      response: null,
      raisedAt: "2026-11-24T08:00:00Z",
      positionCode: null,
    };
  }

  it("formats a tread, a pressure and an odometer it can read as one", () => {
    expect(warningValueText(warning("FR-INS-036", "4"), UNITS)).toBe("4.0 mm");
    expect(warningValueText(warning("FR-INS-041", "4"), UNITS)).toBe("4.0 mm");
    expect(warningValueText(warning("FR-INS-037", "640"), UNITS)).toBe("640 kPa");
    expect(warningValueText(warning("FR-INS-033", "412300"), UNITS)).toBe("412,300 km");
    expect(warningValueText(warning("DR-020", "412300"), UNITS)).toBe("412,300 km");
  });

  // Spec section 4: a rig report's value is a list of unit ids.
  it("shows no value it cannot format as a measurement", () => {
    expect(warningValueText(warning("FR-INS-063", '["a","b"]'), UNITS)).toBeNull();
    expect(warningValueText(warning("FR-OFF-016", "t1"), UNITS)).toBeNull();
    expect(warningValueText(warning("FR-INS-036", null), UNITS)).toBeNull();
    expect(warningValueText(warning("FR-INS-036", "deep"), UNITS)).toBeNull();
  });
});
