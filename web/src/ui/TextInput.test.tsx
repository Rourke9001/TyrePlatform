import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import baseCss from "./base.css?raw";
import damageCss from "./DamageNote.css?raw";
import { TextInput } from "./TextInput";
import inputCss from "./TextInput.css?raw";

// jsdom lays nothing out and applies no stylesheet, so a focus ring is read
// from the rule that draws it.
function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const code = css.replace(/\/\*[\s\S]*?\*\//g, "");
  return new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(code)?.[1] ?? "";
}

describe("the input frame's focus", () => {
  // U53: the control inside draws no outline, so the frame carries the
  // platform ring, and an invalid field's red border cannot hide it.
  it("rings the frame in the platform colour whenever its control has focus", () => {
    for (const [css, selector] of [
      [inputCss, ".tr-input:has(:focus-visible)"],
      [damageCss, ".tr-damage__input:has(:focus-visible)"],
    ] as const) {
      const body = ruleBody(css, selector);
      expect(body, selector).toMatch(/outline:\s*3px solid var\(--interactive\)/);
      expect(body, selector).toMatch(/outline-offset:\s*2px/);
    }
  });

  // WCAG 2.4.11: both shells' bars are sticky, so a control focus scrolls
  // to stops below the bar, not under it.
  it("keeps a focused control clear of the sticky bar", () => {
    expect(ruleBody(baseCss, "html")).toMatch(
      /scroll-padding-top:\s*calc\(var\(--appbar\) \+ var\(--space-2\)\)/,
    );
  });
});

describe("TextInput", () => {
  it("puts the control's props on the input and the class on its frame", async () => {
    const onChange = vi.fn();
    render(
      <TextInput
        aria-label="Odometer"
        name="odometer"
        data-testid="odo"
        className="extra"
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("textbox", { name: "Odometer" });
    expect(input).toHaveAttribute("name", "odometer");
    expect(input).toHaveAttribute("data-testid", "odo");
    expect(input.parentElement).toHaveClass("tr-input", "extra");
    await userEvent.type(input, "12");
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("shows a caller's prefix and suffix beside the value", () => {
    render(<TextInput aria-label="Price" prefix="R" suffix="per tyre" />);
    const input = screen.getByRole("textbox", { name: "Price" });
    expect(input.previousElementSibling).toHaveTextContent("R");
    expect(input.nextElementSibling).toHaveTextContent("per tyre");
  });

  it("flags its frame when the input is invalid, and takes the glove and mono looks", () => {
    render(<TextInput aria-label="Fleet number" aria-invalid size="glove" mono />);
    const frame = screen.getByRole("textbox", { name: "Fleet number" }).parentElement;
    expect(frame).toHaveAttribute("data-invalid", "true");
    expect(frame).toHaveClass("tr-input--glove", "tr-input--mono");
  });

  it("leaves its frame unflagged when aria-invalid is false", () => {
    render(
      <>
        <TextInput aria-label="As a string" aria-invalid="false" />
        <TextInput aria-label="As a boolean" aria-invalid={false} />
      </>,
    );
    for (const name of ["As a string", "As a boolean"]) {
      const frame = screen.getByRole("textbox", { name }).parentElement;
      expect(frame).not.toHaveAttribute("data-invalid");
    }
  });
});
