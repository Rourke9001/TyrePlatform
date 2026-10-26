import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Field } from "./Field";
import { TextInput } from "./TextInput";

describe("Field", () => {
  it("Field wires hint and error to aria-describedby and sets aria-invalid", () => {
    render(
      <Field label="Fleet number" hint="As painted on the cab" error="Enter a fleet number">
        <TextInput />
      </Field>,
    );
    const input = screen.getByLabelText("Fleet number");
    expect(input.tagName).toBe("INPUT");
    expect(input).toHaveAccessibleDescription("As painted on the cab Enter a fleet number");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("leaves the control undescribed and valid with no hint or error", () => {
    render(
      <Field label="Fleet number">
        <TextInput />
      </Field>,
    );
    const input = screen.getByLabelText("Fleet number");
    expect(input).not.toHaveAttribute("aria-describedby");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("keeps the control's own id and description", () => {
    render(
      <>
        <p id="outside">Shown above the form</p>
        <Field label="Registration" hint="As on the licence disc">
          <TextInput id="reg" aria-describedby="outside" />
        </Field>
      </>,
    );
    const input = screen.getByLabelText("Registration");
    expect(input).toHaveAttribute("id", "reg");
    expect(input).toHaveAccessibleDescription("Shown above the form As on the licence disc");
  });

  it("marks an optional field and hides the error glyph", () => {
    const { container } = render(
      <Field label="Notes" optional error="Too long" data-testid="field">
        <TextInput />
      </Field>,
    );
    expect(screen.getByText("(optional)")).toBeInTheDocument();
    expect(container.querySelector(".tr-field__error svg")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByTestId("field")).toHaveClass("tr-field");
  });
});
