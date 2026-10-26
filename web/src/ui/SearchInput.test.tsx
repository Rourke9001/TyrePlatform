import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SearchInput } from "./SearchInput";

describe("SearchInput", () => {
  it("is a search box named by its required label", () => {
    const { container } = render(<SearchInput label="Find a tyre" name="q" data-testid="q" />);
    const box = screen.getByRole("searchbox", { name: "Find a tyre" });
    expect(box).toHaveAttribute("type", "search");
    expect(box).toHaveAttribute("name", "q");
    expect(box).toHaveAttribute("data-testid", "q");
    expect(screen.getByRole("search")).toContainElement(box);
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("takes the glove size", () => {
    render(<SearchInput label="Find a vehicle" size="glove" />);
    expect(screen.getByRole("search")).toHaveClass("tr-input", "tr-input--glove");
  });
});
