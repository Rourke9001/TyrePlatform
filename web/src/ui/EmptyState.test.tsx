import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./EmptyState";
import { Truck } from "./icons/Truck";

describe("EmptyState", () => {
  it("titles itself at level 3 by default, with a body and an action", () => {
    const { container } = render(
      <EmptyState title="No exceptions" action={<button type="button">Refresh</button>}>
        Every tyre is inside the fleet's policy.
      </EmptyState>,
    );
    expect(screen.getByRole("heading", { level: 3, name: "No exceptions" })).toBeInTheDocument();
    expect(screen.getByText("Every tyre is inside the fleet's policy.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(container.querySelector(".tr-empty__icon")).toHaveAttribute("aria-hidden", "true");
  });

  // The title nests under the heading the state sits beneath.
  it("takes the heading level and glyph it is given and passes unknown props on", () => {
    const { container } = render(
      <EmptyState title="No vehicles" headingLevel={2} icon={Truck} data-testid="empty" />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "No vehicles" })).toBeInTheDocument();
    expect(screen.getByTestId("empty")).toHaveClass("tr-empty");
    expect(container.querySelector(".tr-empty__body")).toBeNull();
    expect(container.querySelectorAll("svg circle")).toHaveLength(2);
  });
});
