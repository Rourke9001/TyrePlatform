import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Badge } from "./Badge";
import { TyreIcon } from "./icons/Tyre";

describe("Badge", () => {
  it("shows the caller's words in the neutral tone", () => {
    render(<Badge>Fitted</Badge>);
    expect(screen.getByText("Fitted")).toHaveClass("tr-badge", "tr-badge--neutral");
  });

  it("hides its glyph and passes unknown props on", () => {
    const { container } = render(
      <Badge icon={TyreIcon} data-testid="role">
        Driver
      </Badge>,
    );
    expect(screen.getByTestId("role")).toHaveTextContent(/^Driver$/);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });
});
