import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Select } from "./Select";

const options = [
  { value: "CRITICAL", label: "Critical" },
  { value: "WARNING", label: "Warning" },
];

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
});
