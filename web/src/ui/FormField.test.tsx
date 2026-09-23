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
});
