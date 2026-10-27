import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UnitPlan } from "./UnitPlan";
import { openFitment, unit, unitPosition } from "../../test/fixtures";

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
const UNIT = unit({ positions: POSITIONS });

describe("the unit plan", () => {
  it("draws one button per position, spare included, however many axles there are", () => {
    render(<UnitPlan unit={UNIT} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getAllByRole("button")).toHaveLength(POSITIONS.length);
    expect(screen.getByRole("button", { name: "Position SPARE1: empty" })).toBeTruthy();
  });

  it("names each position by its occupant, or says it is empty", () => {
    render(<UnitPlan unit={UNIT} selectedId={null} onSelect={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Position POS3: TY100" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Position POS4: empty" })).toBeTruthy();
  });

  // A toggle states its state either way, so a plan with nothing picked
  // says every position is unpressed rather than saying nothing.
  it("states every position unpressed until one is picked", () => {
    render(<UnitPlan unit={UNIT} selectedId={null} onSelect={vi.fn()} />);

    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("marks the selected position and no other", () => {
    render(<UnitPlan unit={UNIT} selectedId="p3" onSelect={vi.fn()} />);

    const pressed = screen
      .getAllByRole("button")
      .filter((el) => el.getAttribute("aria-pressed") === "true");
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute("data-position-id")).toBe("p3");
  });

  // Both keys a button answers to select, each exactly once, since a second
  // call would select a position the user did not pick.
  it("selects on click, on Enter and on Space, so the plan needs no mouse", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<UnitPlan unit={UNIT} selectedId={null} onSelect={onSelect} />);

    await user.click(screen.getByRole("button", { name: "Position POS2: empty" }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("p2");

    onSelect.mockClear();
    screen.getByRole("button", { name: "Position POS5: empty" }).focus();
    await user.keyboard("{Enter}");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("p5");

    onSelect.mockClear();
    screen.getByRole("button", { name: "Position POS6: empty" }).focus();
    await user.keyboard(" ");
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("p6");
  });

  // Spare count is tenant data (FR-VEH-002), so a plan that drew a fixed
  // number of spare slots would drop the fourth.
  it("draws every spare as a button in the spares group, however many there are", () => {
    const spares = [1, 2, 3, 4].map((n) =>
      unitPosition({
        id: `sp${n}`,
        code: `SPARE${n}`,
        axleNumber: null,
        side: null,
        slot: null,
        axleClass: "SPARE",
        isSpare: true,
      }),
    );
    render(
      <UnitPlan
        unit={unit({ positions: [...POSITIONS, ...spares] })}
        selectedId={null}
        onSelect={vi.fn()}
      />,
    );

    const plan = screen.getByRole("group", { name: "Unit plan view" });
    const group = within(plan).getByRole("group", { name: "Spares" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => b.getAttribute("data-position-id")),
    ).toEqual(["sp", ...spares.map((s) => s.id)]);
  });

  it("labels each axle group so a reader can tell axle 2 from axle 3", () => {
    render(<UnitPlan unit={UNIT} selectedId={null} onSelect={vi.fn()} />);

    const axle2 = screen.getByRole("group", { name: "Axle 2" });
    expect(within(axle2).getAllByRole("button")).toHaveLength(2);
  });
});
