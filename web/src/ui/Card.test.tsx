import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Card } from "./Card";

describe("Card", () => {
  it("Card is a region named by its title", () => {
    render(
      <Card
        title="Your trip"
        eyebrow="Today"
        description="The truck and trailers you are on."
        actions={<button type="button">Refresh</button>}
        data-requirement="FR-DSH-012"
      >
        <ul>
          <li>HORSE</li>
        </ul>
      </Card>,
    );
    const card = screen.getByRole("region", { name: "Your trip" });
    expect(card.tagName).toBe("SECTION");
    expect(card).toHaveAttribute("data-requirement", "FR-DSH-012");
    expect(within(card).getByRole("heading", { level: 2, name: "Your trip" })).toBeInTheDocument();
    expect(within(card).getByRole("listitem")).toHaveTextContent("HORSE");
    expect(within(card).getByRole("button", { name: "Refresh" })).toBeInTheDocument();
    expect(card).toHaveTextContent("The truck and trailers you are on.");
  });

  it("renders as an article at the heading level it is given", () => {
    render(
      <Card as="article" title="Spares" level={3}>
        <p>body</p>
      </Card>,
    );
    const card = screen.getByRole("article", { name: "Spares" });
    expect(within(card).getByRole("heading", { level: 3, name: "Spares" })).toBeInTheDocument();
  });

  it("keeps a caller's own name over its title", () => {
    render(
      <Card title="Nominated" aria-label="Nominated inspections">
        <p>body</p>
      </Card>,
    );
    expect(screen.getByRole("region", { name: "Nominated inspections" })).toBeInTheDocument();
  });

  it("is no landmark without a title", () => {
    render(
      <Card>
        <p>body</p>
      </Card>,
    );
    expect(screen.queryByRole("region")).toBeNull();
    expect(screen.getByText("body")).toBeInTheDocument();
  });
});
