import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { ChoiceChips } from "./ChoiceChips";

const options = [
  { value: "cut", label: "Cut" },
  { value: "bulge", label: "Bulge" },
  { value: "uneven", label: "Uneven wear" },
];

function Controlled() {
  const [value, setValue] = useState<string | null>(null);
  return <ChoiceChips label="Damage" options={options} value={value} onChange={setValue} />;
}

function tabStops(): string[] {
  return screen
    .getAllByRole("radio")
    .filter((radio) => radio.tabIndex === 0)
    .map((radio) => radio.textContent ?? "");
}

describe("ChoiceChips", () => {
  it("is one radio group with one tab stop before anything is chosen", () => {
    render(<Controlled />);
    expect(screen.getByRole("radiogroup", { name: "Damage" })).toBeInTheDocument();
    expect(tabStops()).toEqual(["Cut"]);
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
  });

  it("selects on click, marks the choice with a hidden check, and moves with arrows", async () => {
    const { container } = render(<Controlled />);
    await userEvent.click(screen.getByRole("radio", { name: "Bulge" }));
    const bulge = screen.getByRole("radio", { name: "Bulge" });
    expect(bulge).toBeChecked();
    expect(bulge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelectorAll("svg")).toHaveLength(1);

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Uneven wear" })).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Uneven wear" })).toBeChecked();
    expect(tabStops()).toEqual(["Uneven wear"]);
  });

  // The same browser and screen reader keys SegmentedControl lets through.
  it("leaves an arrow with a modifier to the browser", () => {
    const onChange = vi.fn();
    render(<ChoiceChips label="Damage" options={options} value="bulge" onChange={onChange} />);
    const bulge = screen.getByRole("radio", { name: "Bulge" });
    bulge.focus();
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
        expect(fireEvent.keyDown(bulge, { key, [modifier]: true })).toBe(true);
      }
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(bulge).toHaveFocus();
    expect(fireEvent.keyDown(bulge, { key: "ArrowLeft" })).toBe(false);
    expect(onChange).toHaveBeenCalledWith("cut");
  });

  it("takes the glove size and passes unknown props to the group", () => {
    render(
      <ChoiceChips
        label="Cause"
        options={options}
        value="cut"
        onChange={vi.fn()}
        size="glove"
        data-testid="cause"
      />,
    );
    expect(screen.getByTestId("cause")).toHaveClass("tr-chips", "tr-chips--glove");
  });
});
