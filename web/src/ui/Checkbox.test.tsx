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

  it("is named by its label, described by its line, and toggles", async () => {
    render(<Checkbox label="Valve caps fitted" description="All positions" />);
    const box = screen.getByRole("checkbox", { name: /Valve caps fitted/ });
    expect(screen.getByText("All positions")).toBeInTheDocument();
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
});
