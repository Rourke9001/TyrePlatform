import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FormField } from "./FormField";
import { Select } from "./Select";

const options = [
  { value: "ALL", label: "All depots" },
  { value: "d1", label: "Johannesburg" },
  { value: "d2", label: "Durban" },
];

describe("Select", () => {
  it("is a labelled combobox that opens from the keyboard and reports the choice", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select
        id="depot"
        aria-label="Depot"
        value="ALL"
        onValueChange={onValueChange}
        options={options}
      />,
    );
    const trigger = screen.getByRole("combobox", { name: "Depot" });
    expect(trigger).toHaveTextContent("All depots");
    trigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "Durban" }));
    expect(onValueChange).toHaveBeenCalledWith("d2");
  });

  // FormField wires its hint and error by id; a Radix trigger only hears them
  // if Select forwards what FormField clones onto it (ruling P5).
  it("takes its name from the field's label and its description from the hint and error", () => {
    render(
      <FormField id="depot" label="Depot" hint="Active depots only" error="Choose a depot">
        <Select id="depot" value="ALL" onValueChange={() => undefined} options={options} />
      </FormField>,
    );
    const trigger = screen.getByRole("combobox", { name: "Depot" });
    expect(trigger).toHaveAccessibleDescription("Active depots only Choose a depot");
    expect(trigger).toHaveAttribute("aria-invalid", "true");
  });
});
