import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UnitPlan } from "./UnitPlan";
import { openFitment, unitPosition } from "../../test/fixtures";

// A four-axle interlink with a spare: enough axles that a layout carrying a
// hard-coded count would drop one, and enough sides and slots that the
// geometry has to come off the read.
const POSITIONS = [
  unitPosition({ id: "p1", code: "POS1", axleNumber: 1, side: "LEFT", slot: "SINGLE" }),
  unitPosition({ id: "p2", code: "POS2", axleNumber: 1, side: "RIGHT", slot: "SINGLE" }),
  unitPosition({
    id: "p3",
    code: "POS3",
    axleNumber: 2,
    side: "LEFT",
    slot: "OUTER",
    fitment: openFitment({ displayCode: "TY100" }),
  }),
  unitPosition({ id: "p4", code: "POS4", axleNumber: 2, side: "LEFT", slot: "INNER" }),
  unitPosition({ id: "p5", code: "POS5", axleNumber: 3, side: "RIGHT", slot: "OUTER" }),
  unitPosition({ id: "p6", code: "POS6", axleNumber: 4, side: "RIGHT", slot: "INNER" }),
  unitPosition({
    id: "sp",
    code: "SPARE1",
    axleNumber: null,
    side: null,
    slot: null,
    axleClass: "SPARE",
    isSpare: true,
  }),
];

describe("the unit plan", () => {
  it("draws one button per position, spare included, however many axles there are", () => {
    render(<UnitPlan positions={POSITIONS} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(POSITIONS.length);
    expect(screen.getByRole("button", { name: "Position SPARE1: empty" })).toBeTruthy();
  });

  it("names each position by its occupant, or says it is empty", () => {
    render(<UnitPlan positions={POSITIONS} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Position POS3: TY100" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Position POS4: empty" })).toBeTruthy();
  });

  it("marks the selected position and no other", () => {
    render(<UnitPlan positions={POSITIONS} selectedId="p3" onSelect={vi.fn()} />);

    const pressed = screen
      .getAllByRole("button")
      .filter((el) => el.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute("data-position-id")).toBe("p3");
  });

  it("selects on click and on Enter, so the plan is reachable without a mouse", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<UnitPlan positions={POSITIONS} selectedId={null} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Position POS2: empty" }));
    expect(onSelect).toHaveBeenCalledWith("p2");

    screen.getByRole("button", { name: "Position POS5: empty" }).focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledWith("p5");
  });

  it("labels each axle group so a reader can tell axle 2 from axle 3", () => {
    render(<UnitPlan positions={POSITIONS} selectedId={null} onSelect={vi.fn()} />);

    const axle2 = screen.getByRole("group", { name: "Axle 2" });
    expect(within(axle2).getAllByRole("button")).toHaveLength(2);
  });
});
