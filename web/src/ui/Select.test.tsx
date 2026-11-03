import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { cssRules, declarations } from "../test/cssRules";
import { Select } from "./Select";
import selectCss from "./Select.css?raw";

const options = [
  { value: "CRITICAL", label: "Critical" },
  { value: "WARNING", label: "Warning" },
];

// The declarations Select.css gives an element, later rules winning.
function declared(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rule of cssRules(selectCss)) {
    if (!rule.selectors.some((s) => el.matches(s))) continue;
    for (const { property, value } of declarations(rule.body)) out[property] = value;
  }
  return out;
}

describe("Select", () => {
  it("is a native select with the caller's options and props", async () => {
    const onChange = vi.fn();
    const { container } = render(
      <Select aria-label="Severity" options={options} name="severity" onChange={onChange} />,
    );
    const select = screen.getByRole("combobox", { name: "Severity" });
    expect(select.tagName).toBe("SELECT");
    expect(select).toHaveAttribute("name", "severity");
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Critical",
      "Warning",
    ]);
    await userEvent.selectOptions(select, "WARNING");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(select).toHaveValue("WARNING");
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("offers a placeholder that cannot be chosen back", () => {
    render(<Select aria-label="Rule" options={options} placeholder="Any rule" defaultValue="" />);
    const placeholder = screen.getByRole("option", { name: "Any rule" });
    expect(placeholder).toBeDisabled();
    expect(placeholder).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "Rule" })).toHaveValue("");
  });

  it("flags its frame when invalid", () => {
    render(<Select aria-label="Rule" options={options} aria-invalid size="glove" />);
    const frame = screen.getByRole("combobox", { name: "Rule" }).parentElement;
    expect(frame).toHaveAttribute("data-invalid", "true");
    expect(frame).toHaveClass("tr-input", "tr-input--glove");
  });

  it("disables only the options marked disabled", () => {
    render(
      <Select aria-label="Severity" options={[options[0], { ...options[1], disabled: true }]} />,
    );
    expect(screen.getByRole("option", { name: "Critical" })).toBeEnabled();
    expect(screen.getByRole("option", { name: "Warning" })).toBeDisabled();
  });

  // jsdom applies no layout, so this reads the sheet. A chevron laid out
  // beside the select takes a click itself and opens nothing. Drawn over
  // the select's padding with no pointer events, it lets the click through.
  // It reads Select.css alone, so it cannot see a rule elsewhere that
  // outranks these; it pins the mechanism, not the click.
  it("draws its chevron over the select, so a click on it reaches the select", () => {
    const { container } = render(<Select aria-label="Rule" options={options} />);
    const select = screen.getByRole("combobox", { name: "Rule" });
    const chevron = container.querySelector("svg");
    expect(chevron).not.toBeNull();
    if (chevron === null) return;
    expect(chevron.parentElement).toBe(select.parentElement);
    expect(declared(chevron)).toMatchObject({ position: "absolute", "pointer-events": "none" });
    expect(declared(select.parentElement!)).toMatchObject({ position: "relative" });
    // Two classes, for the reason Select.css gives.
    const pad = cssRules(selectCss).find(
      (r) =>
        r.selectors.some((s) => select.matches(s)) &&
        declarations(r.body).some((d) => d.property === "padding-right"),
    );
    expect(pad?.selectors.find((s) => select.matches(s))?.match(/\.[\w-]+/g)?.length).toBe(2);
  });
});
