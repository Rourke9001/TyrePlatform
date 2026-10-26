import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KeyValue } from "./KeyValue";

describe("KeyValue", () => {
  it("sets each label as a term beside its value", () => {
    render(
      <KeyValue
        columns={3}
        items={[
          { label: "Size", value: "315/80R22.5", mono: true },
          { label: "Depot", value: "Sandbox depot" },
        ]}
        data-testid="facts"
      />,
    );
    const list = screen.getByTestId("facts");
    expect(list.tagName).toBe("DL");
    expect(list.style.getPropertyValue("--tr-kv-cols")).toBe("3");
    const size = screen.getByText("Size", { selector: "dt" }).nextElementSibling;
    expect(size).toHaveTextContent("315/80R22.5");
    expect(size).toHaveAttribute("data-mono", "true");
    const depot = screen.getByText("Depot", { selector: "dt" }).nextElementSibling;
    expect(depot).not.toHaveAttribute("data-mono");
  });
});
