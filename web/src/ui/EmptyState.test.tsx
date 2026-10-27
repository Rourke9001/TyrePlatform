import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "./EmptyState";
import { TruckIcon } from "./icons/Truck";

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
      <EmptyState title="No vehicles" headingLevel={2} icon={TruckIcon} data-testid="empty" />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "No vehicles" })).toBeInTheDocument();
    expect(screen.getByTestId("empty")).toHaveClass("tr-empty");
    expect(container.querySelector(".tr-empty__body")).toBeNull();
    expect(container.querySelectorAll("svg circle")).toHaveLength(2);
  });

  // A paragraph cannot hold a list or a second paragraph, so the body is a
  // div that takes any block a caller passes.
  it("holds a block body in valid markup", () => {
    const { container } = render(
      <EmptyState title="Nothing to send">
        <p>The outbox is empty.</p>
        <ul>
          <li>Readings send as you capture them.</li>
        </ul>
      </EmptyState>,
    );
    const body = container.querySelector(".tr-empty__body");
    expect(body?.tagName).toBe("DIV");
    expect(body?.querySelector("p, ul")).not.toBeNull();
  });
});
