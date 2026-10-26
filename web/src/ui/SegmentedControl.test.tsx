import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SegmentedControl } from "./SegmentedControl";
import segmentedCss from "./SegmentedControl.css?raw";

// jsdom lays nothing out, so a target's size is read from its rule.
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(code)?.[1] ?? "";
}

const options = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

function Controlled({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial);
  return <SegmentedControl label="Period" options={options} value={value} onChange={setValue} />;
}

function tabStops(): string[] {
  return screen
    .getAllByRole("radio")
    .filter((radio) => radio.tabIndex === 0)
    .map((radio) => radio.textContent ?? "");
}

describe("SegmentedControl", () => {
  it("SegmentedControl moves with arrow keys and keeps one tab stop", async () => {
    render(<Controlled initial="day" />);
    expect(screen.getByRole("radiogroup", { name: "Period" })).toBeInTheDocument();
    expect(tabStops()).toEqual(["Day"]);

    await userEvent.tab();
    expect(screen.getByRole("radio", { name: "Day" })).toHaveFocus();

    await userEvent.keyboard("{ArrowRight}");
    const week = screen.getByRole("radio", { name: "Week" });
    expect(week).toHaveFocus();
    expect(week).toBeChecked();
    expect(tabStops()).toEqual(["Week"]);

    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("radio", { name: "Day" })).toHaveFocus();
    expect(tabStops()).toEqual(["Day"]);

    await userEvent.keyboard("{ArrowLeft}");
    expect(screen.getByRole("radio", { name: "Month" })).toBeChecked();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("radio", { name: "Week" })).toBeChecked();
    expect(tabStops()).toEqual(["Week"]);
  });

  it("keeps the first option as the tab stop when the value matches none", () => {
    render(<SegmentedControl label="Period" options={options} value="" onChange={vi.fn()} />);
    expect(tabStops()).toEqual(["Day"]);
    for (const radio of screen.getAllByRole("radio")) expect(radio).not.toBeChecked();
  });

  // NFR-USE-004: each option is a target in its own right, so the floor
  // holds without the group's inset.
  it("makes each option a 44px target, or 56px for gloves", () => {
    expect(ruleBody(segmentedCss, ".tr-seg__opt")).toMatch(/min-height:\s*var\(--target-min\)/);
    expect(ruleBody(segmentedCss, ".tr-seg--glove .tr-seg__opt")).toMatch(
      /min-height:\s*var\(--target-glove\)/,
    );
  });

  it("selects on click", async () => {
    render(<Controlled initial="day" />);
    await userEvent.click(screen.getByRole("radio", { name: "Month" }));
    expect(screen.getByRole("radio", { name: "Month" })).toBeChecked();
    expect(tabStops()).toEqual(["Month"]);
  });

  it("takes the glove and block looks and passes unknown props to the group", () => {
    render(
      <SegmentedControl
        label="Theme"
        options={options}
        value="day"
        onChange={vi.fn()}
        size="glove"
        block
        data-testid="theme"
      />,
    );
    expect(screen.getByTestId("theme")).toHaveClass("tr-seg", "tr-seg--glove", "tr-seg--block");
  });
});
