import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./Button";

describe("Button", () => {
  it("defaults to type=button so a stray click never submits a form", () => {
    render(<Button>Refresh</Button>);
    expect(screen.getByRole("button", { name: "Refresh" })).toHaveAttribute("type", "button");
  });

  it("carries the variant and compact classes", () => {
    render(
      <Button variant="danger" compact>
        Dispose
      </Button>,
    );
    const button = screen.getByRole("button", { name: "Dispose" });
    expect(button.className).toContain("btn-danger");
    expect(button.className).toContain("btn-compact");
  });
});
