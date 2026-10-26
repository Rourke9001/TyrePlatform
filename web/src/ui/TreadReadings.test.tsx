import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { expectNothingForbiddenSpoken } from "../test/spoken";
import { TreadReadings } from "./TreadReadings";

const cell = (n: number, of = 3) =>
  screen.getByRole("button", { name: `Tread reading ${n} of ${of}` });

describe("TreadReadings", () => {
  it("TreadReadings names cells Tread reading N of M and marks the active one with aria-current", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(i: number) => void>();
    render(
      <TreadReadings
        readings={["13", "", ""]}
        governingIndex={null}
        activeIndex={1}
        onSelect={onSelect}
      />,
    );
    expect(cell(1)).not.toHaveAttribute("aria-current");
    expect(cell(2)).toHaveAttribute("aria-current", "true");
    expect(cell(3)).not.toHaveAttribute("aria-current");

    await user.click(cell(3));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(2);
  });

  it("takes the caller's cell names over the default", () => {
    render(
      <TreadReadings
        readings={["13", "12"]}
        governingIndex={null}
        onSelect={vi.fn()}
        cellLabel={(i, n) => `Reading ${i + 1}/${n}`}
      />,
    );
    expect(screen.getByRole("button", { name: "Reading 1/2" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reading 2/2" })).toBeInTheDocument();
  });

  it("TreadReadings shows a dash in an empty cell", () => {
    render(<TreadReadings readings={["13", ""]} governingIndex={null} onSelect={vi.fn()} />);
    expect(cell(2, 2)).toHaveTextContent("–");
    expect(cell(1, 2)).toHaveTextContent("13");
    expect(cell(1, 2)).not.toHaveTextContent("–");
  });

  it("shows the caller's unit under every tread cell and no unit of its own", () => {
    const { rerender } = render(
      <TreadReadings
        readings={["13", ""]}
        governingIndex={null}
        onSelect={vi.fn()}
        unitText="mm"
      />,
    );
    expect(cell(1, 2)).toHaveTextContent("mm");
    expect(cell(2, 2)).toHaveTextContent("mm");

    rerender(<TreadReadings readings={["13", ""]} governingIndex={null} onSelect={vi.fn()} />);
    expect(cell(1, 2).textContent).toBe("113");
    expect(cell(2, 2).textContent).toBe("2–");
  });

  // CR-011: the governing reading is the one the caller names. The fixture's
  // minimum is in the middle, and a second render names a cell that is not
  // the minimum, so a component computing its own MIN() fails either way.
  it("TreadReadings marks the governingIndex it is given", () => {
    const readings = ["12", "9", "14"];
    const { rerender } = render(
      <TreadReadings
        readings={readings}
        governingIndex={1}
        governingText="Lowest"
        onSelect={vi.fn()}
      />,
    );
    expect(cell(1)).not.toHaveAttribute("data-governing");
    expect(cell(2)).toHaveAttribute("data-governing", "true");
    expect(cell(3)).not.toHaveAttribute("data-governing");
    expect(cell(2)).toHaveTextContent("Lowest");

    rerender(<TreadReadings readings={readings} governingIndex={2} onSelect={vi.fn()} />);
    expect(cell(2)).not.toHaveAttribute("data-governing");
    expect(cell(3)).toHaveAttribute("data-governing", "true");

    rerender(<TreadReadings readings={readings} governingIndex={null} onSelect={vi.fn()} />);
    for (const n of [1, 2, 3]) expect(cell(n)).not.toHaveAttribute("data-governing");
  });

  it("TreadReadings renders a Pressure cell when given", async () => {
    const user = userEvent.setup();
    const onPressure = vi.fn<() => void>();
    const { container, rerender } = render(
      <TreadReadings
        readings={["13", "13", "14"]}
        governingIndex={0}
        onSelect={vi.fn()}
        unitText="mm"
        pressure={{
          value: "",
          caption: "Press.",
          unitText: "kPa",
          ariaLabel: "Pressure",
          active: true,
          onSelect: onPressure,
        }}
      />,
    );
    const pressure = screen.getByRole("button", { name: "Pressure" });
    expect(pressure).toHaveAttribute("aria-current", "true");
    expect(pressure).toHaveTextContent("Press.");
    expect(pressure).toHaveTextContent("kPa");
    expect(pressure).toHaveTextContent("–");
    expect(pressure).not.toHaveAttribute("data-governing");
    // IR-UI-013: one row, the pressure after the treads.
    expect(pressure.parentElement).toBe(cell(1).parentElement);
    expect(pressure.parentElement?.lastElementChild).toBe(pressure);
    await user.click(pressure);
    expect(onPressure).toHaveBeenCalledOnce();
    expect(container.querySelectorAll("[aria-current]")).toHaveLength(1);

    rerender(<TreadReadings readings={["13", "13", "14"]} governingIndex={0} onSelect={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Pressure" })).toBeNull();
  });

  // FR-INS-029a, D-A: a driver sees numbers, never inner or outer.
  it("numbers its cells by default and speaks no side word", () => {
    const { container } = render(
      <TreadReadings
        readings={["13", "12", "14"]}
        governingIndex={1}
        onSelect={vi.fn()}
        side="left"
      />,
    );
    expectNothingForbiddenSpoken(container, /tread reading 1 of 3/);
  });

  it("names the cells by side only when asked to", () => {
    const { rerender } = render(
      <TreadReadings readings={["13", "12", "14"]} governingIndex={1} side="left" naming="named" />,
    );
    const names = () =>
      Array.from(document.querySelectorAll(".tr-tread__name")).map((el) => el.textContent);
    expect(names()).toEqual(["Outer", "Centre", "Inner"]);

    rerender(
      <TreadReadings
        readings={["13", "12", "14"]}
        governingIndex={1}
        side="right"
        naming="named"
      />,
    );
    expect(names()).toEqual(["Inner", "Centre", "Outer"]);
  });

  it("renders no buttons when nothing is selectable, and passes unknown props to its root", () => {
    const { container } = render(
      <TreadReadings readings={["13", "12"]} governingIndex={1} data-testid="treads" />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(container.firstElementChild).toHaveAttribute("data-testid", "treads");
    expect(container).toHaveTextContent("13");
  });
});
