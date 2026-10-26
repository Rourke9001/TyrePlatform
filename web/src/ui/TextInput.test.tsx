import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TextInput } from "./TextInput";

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
