import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FormField } from "./FormField";

describe("FormField", () => {
  it("labels the control and describes it by the hint and the error", () => {
    render(
      <FormField id="from" label="From" hint="YYYY-MM-DD" error="Needs a to date as well">
        <input id="from" type="date" />
      </FormField>,
    );
    const input = screen.getByLabelText("From");
    expect(input).toHaveAccessibleDescription("YYYY-MM-DD Needs a to date as well");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent("Needs a to date as well");
  });

  it("leaves a control's own description alone when it has no hint or error", () => {
    render(
      <>
        <p id="own">Set by the page</p>
        <FormField id="depot" label="Depot">
          <input id="depot" aria-describedby="own" />
        </FormField>
      </>,
    );
    const input = screen.getByLabelText("Depot");
    expect(input).toHaveAccessibleDescription("Set by the page");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("merges a control's own aria-describedby with the hint id, not overwrites it", () => {
    render(
      <FormField id="unit" label="Unit" hint="Enter a whole number">
        <input id="unit" aria-describedby="unit-note" />
      </FormField>,
    );
    const input = screen.getByLabelText("Unit");
    expect(input).toHaveAttribute("aria-describedby", "unit-note unit-hint");
  });
});
