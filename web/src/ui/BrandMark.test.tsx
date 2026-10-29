import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BrandMark } from "./BrandMark";

describe("BrandMark", () => {
  it("BrandMark shows the name and a monogram without a logo", () => {
    const { container } = render(<BrandMark name="Production Check" logoUrl={null} />);
    expect(screen.getByText("Production Check")).toBeInTheDocument();
    const tile = container.querySelector(".tr-brandmark__tile");
    expect(tile).toHaveTextContent("PC");
    expect(tile).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector("img")).toBeNull();
  });

  it("takes the first two letters of a one-word name", () => {
    const { container } = render(<BrandMark name="Sandbox" logoUrl={null} />);
    expect(container.querySelector(".tr-brandmark__tile")).toHaveTextContent("SA");
  });

  it("shows the served logo in place of the monogram", () => {
    const { container } = render(
      <BrandMark name="Sandbox Fleet" logoUrl="/api/org/logo" subtitle="Durban depot" />,
    );
    const img = container.querySelector("img");
    expect(img).toHaveAttribute("src", "/api/org/logo");
    expect(img).toHaveAttribute("alt", "");
    expect(container.querySelector(".tr-brandmark__tile")).toHaveClass("tr-brandmark__tile--logo");
    expect(screen.getByText("Durban depot")).toBeInTheDocument();
  });

  it("keeps the name for a screen reader when it is not shown", () => {
    const { container } = render(
      <BrandMark name="Sandbox Fleet" logoUrl={null} showName={false} />,
    );
    expect(screen.getByText("Sandbox Fleet")).toHaveClass("tr-vh");
    expect(container.querySelector(".tr-brandmark__name")).toBeNull();
  });

  it("outlines the monogram on a brand band and passes unknown props on", () => {
    const { container } = render(
      <BrandMark name="Sandbox Fleet" logoUrl={null} onBrand size="sm" data-testid="mark" />,
    );
    expect(screen.getByTestId("mark")).toHaveClass("tr-brandmark", "tr-brandmark--sm");
    expect(container.querySelector(".tr-brandmark__tile")).toHaveClass(
      "tr-brandmark__tile--on-brand",
    );
  });

  // A name can start with a character outside the basic plane, which takes
  // two UTF-16 units; half of one draws a broken glyph.
  it("takes whole characters for the monogram", () => {
    const { container, rerender } = render(<BrandMark name="𝒜cme Logistics" logoUrl={null} />);
    expect(container.querySelector(".tr-brandmark__tile")).toHaveTextContent(/^𝒜L$/);
    rerender(<BrandMark name="𝒜cme" logoUrl={null} />);
    expect(container.querySelector(".tr-brandmark__tile")).toHaveTextContent(/^𝒜C$/);
  });
});
