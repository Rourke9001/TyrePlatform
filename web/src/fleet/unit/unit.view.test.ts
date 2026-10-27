import { describe, expect, it } from "vitest";

import { diagramUnit } from "./unit.view";
import { openFitment, unit, unitPosition } from "../../test/fixtures";

// A dual axle stored out of plan order, a single axle, an axle number with a
// gap before it, and a spare: enough that an order taken from the read, or a
// hard-coded axle count, draws a position on the wrong side or drops one.
const UNIT = unit({
  id: "u9",
  fleetNumber: "HORSE-1",
  positions: [
    unitPosition({
      id: "r-out",
      code: "8",
      axleNumber: 3,
      side: "RIGHT",
      slot: "OUTER",
      sequence: 8,
    }),
    unitPosition({
      id: "l-in",
      code: "6",
      axleNumber: 3,
      side: "LEFT",
      slot: "INNER",
      sequence: 6,
    }),
    unitPosition({
      id: "r-in",
      code: "7",
      axleNumber: 3,
      side: "RIGHT",
      slot: "INNER",
      sequence: 7,
    }),
    unitPosition({
      id: "l-out",
      code: "5",
      axleNumber: 3,
      side: "LEFT",
      slot: "OUTER",
      sequence: 5,
      fitment: openFitment({ displayCode: "TY100" }),
    }),
    unitPosition({
      id: "s-r",
      code: "2",
      axleNumber: 1,
      side: "RIGHT",
      slot: "SINGLE",
      sequence: 2,
    }),
    unitPosition({
      id: "s-l",
      code: "1",
      axleNumber: 1,
      side: "LEFT",
      slot: "SINGLE",
      sequence: 1,
    }),
    unitPosition({
      id: "sp",
      code: "S1",
      axleNumber: null,
      side: null,
      slot: null,
      axleClass: "SPARE",
      isSpare: true,
      sequence: 9,
    }),
  ],
});

describe("the vehicle screen's diagram", () => {
  // BR-VEH-001: plan view, nose up. AxleDiagram draws each side of an axle
  // in the order given, so the left runs outside in and the right inside out.
  it("orders each axle across the vehicle, axles ascending, and keeps spares apart", () => {
    const drawn = diagramUnit(UNIT);

    expect(drawn.axles.map((a) => a.positions.map((p) => p.id))).toEqual([
      ["s-l", "s-r"],
      ["l-out", "l-in", "r-in", "r-out"],
    ]);
    expect(drawn.spares?.map((p) => p.id)).toEqual(["sp"]);
  });

  // BR-VEH-001's per-unit number on the tile, and today's plan wording as
  // its name, which the fitment and rotation specs find positions by.
  it("labels each tile by the position's code and names it by its occupant", () => {
    const tiles = diagramUnit(UNIT).axles.flatMap((a) => a.positions);
    const outer = tiles.find((p) => p.id === "l-out");
    const inner = tiles.find((p) => p.id === "l-in");

    expect(outer).toMatchObject({
      label: "5",
      valueText: "TY100",
      ariaLabel: "Position 5: TY100",
      dataPositionId: "l-out",
    });
    expect(inner).toMatchObject({ label: "6", valueText: "empty", ariaLabel: "Position 6: empty" });
  });

  // fitments.spec.ts finds the mounted positions as the buttons inside an
  // "Axle" group, which is what keeps the spares out of them.
  it("names each axle and the spares as groups", () => {
    const drawn = diagramUnit(UNIT);

    expect(drawn.axles.map((a) => a.ariaLabel)).toEqual(["Axle 1", "Axle 3"]);
    expect(drawn.sparesAriaLabel).toBe("Spares");
  });

  // The wire's side is app.side, LEFT or RIGHT, and null on a spare (000001).
  // AxleDiagram splits an axle by side only when every tile has one, so a
  // value it does not know is left unset rather than guessed.
  it("carries the wire's side onto each tile, and leaves an unknown one unset", () => {
    const drawn = diagramUnit(UNIT);
    const sideOf = (id: string) =>
      [...drawn.axles.flatMap((a) => a.positions), ...(drawn.spares ?? [])].find((p) => p.id === id)
        ?.side;

    expect(sideOf("l-out")).toBe("left");
    expect(sideOf("r-in")).toBe("right");
    expect(sideOf("sp")).toBeUndefined();

    const odd = diagramUnit(
      unit({ positions: [unitPosition({ id: "m", side: "MIDDLE" }), unitPosition({ id: "n" })] }),
    );
    expect(odd.axles[0].positions.map((p) => p.side)).toEqual([undefined, "left"]);
  });

  // The unit wire carries no condition, so a tile states none; and an empty
  // position is still the one a tyre is fitted to, so it stays a button.
  it("gives no tile a condition, and never marks an empty position untappable", () => {
    const drawn = diagramUnit(UNIT);
    const tiles = [...drawn.axles.flatMap((a) => a.positions), ...(drawn.spares ?? [])];

    expect(tiles).toHaveLength(UNIT.positions.length);
    for (const tile of tiles) {
      expect(tile.condition).toBeUndefined();
      expect(tile.empty).toBeUndefined();
    }
  });
});
