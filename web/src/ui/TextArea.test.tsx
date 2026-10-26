import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TextArea } from "./TextArea";

describe("TextArea", () => {
  it("is three rows by default and takes the control's props", () => {
    render(<TextArea aria-label="Damage note" name="note" data-testid="note" />);
    const area = screen.getByRole("textbox", { name: "Damage note" });
    expect(area.tagName).toBe("TEXTAREA");
    expect(area).toHaveAttribute("rows", "3");
    expect(area).toHaveAttribute("name", "note");
    expect(area.parentElement).toHaveClass("tr-input", "tr-input--area");
  });

  it("takes a row count and flags its frame when invalid", () => {
    render(<TextArea aria-label="Reason" rows={5} aria-invalid size="glove" />);
    const area = screen.getByRole("textbox", { name: "Reason" });
    expect(area).toHaveAttribute("rows", "5");
    expect(area.parentElement).toHaveAttribute("data-invalid", "true");
    expect(area.parentElement).toHaveClass("tr-input--glove");
  });
});
