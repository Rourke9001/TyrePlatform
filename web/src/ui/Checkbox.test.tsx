import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { Checkbox } from "./Checkbox";
import checkboxCss from "./Checkbox.css?raw";

// jsdom lays nothing out, so the target size is read from the rule the
// class carries.
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(code)?.[1] ?? "";
}

describe("Checkbox", () => {
  // NFR-USE-004: a list a driver ticks is a 56px target.
  it("Checkbox card variant is a glove target", () => {
    render(<Checkbox label="Spare checked" variant="card" />);
    const root = screen.getByRole("checkbox", { name: "Spare checked" }).closest("label");
    expect(root).toHaveClass("tr-check", "tr-check--card");
    expect(ruleBody(checkboxCss, ".tr-check--card")).toMatch(/min-height:\s*var\(--target-glove\)/);
    expect(ruleBody(checkboxCss, ".tr-check")).toMatch(/min-height:\s*var\(--target-min\)/);
  });

  // A screen asserts a checkbox by its exact name, so the line under the
  // label describes the box and never joins its name.
  it("is named by its label alone, described by its line, and toggles", async () => {
    render(<Checkbox label="Valve caps fitted" description="All positions" />);
    const box = screen.getByRole("checkbox", { name: "Valve caps fitted" });
    expect(box).toHaveAccessibleName("Valve caps fitted");
    expect(box).toHaveAccessibleDescription("All positions");
    expect(box).not.toBeChecked();
    await userEvent.click(screen.getByText("Valve caps fitted"));
    expect(box).toBeChecked();
  });

  it("passes the control's props to the input and hides the drawn box", () => {
    const { container } = render(
      <Checkbox label="Include replaced" name="replaced" data-testid="replaced" defaultChecked />,
    );
    const box = screen.getByTestId("replaced");
    expect(box).toHaveAttribute("type", "checkbox");
    expect(box).toHaveAttribute("name", "replaced");
    expect(box).toBeChecked();
    expect(container.querySelector(".tr-check__box")).toHaveAttribute("aria-hidden", "true");
  });

  it("keeps a caller's description and name ahead of its own", () => {
    render(
      <>
        <p id="outside">Checked at the depot</p>
        <Checkbox label="Spare checked" description="Inflated" aria-describedby="outside" />
        <Checkbox label="Seen" description="Both sides" aria-label="Sidewalls seen" />
      </>,
    );
    expect(screen.getByRole("checkbox", { name: "Spare checked" })).toHaveAccessibleDescription(
      "Checked at the depot Inflated",
    );
    expect(screen.getByRole("checkbox", { name: "Sidewalls seen" })).toHaveAccessibleDescription(
      "Both sides",
    );
  });

  it("leaves a box without a description named by its label element", () => {
    render(<Checkbox label="Include replaced" />);
    const box = screen.getByRole("checkbox", { name: "Include replaced" });
    expect(box).not.toHaveAttribute("aria-labelledby");
    expect(box).not.toHaveAttribute("aria-describedby");
  });
});
