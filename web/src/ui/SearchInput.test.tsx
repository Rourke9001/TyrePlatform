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
    expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  // A screen keeps the landmarks it has today, so a field used as a filter
  // adds none unless the caller asks for one.
  it("adds no landmark by default", () => {
    render(<SearchInput label="Find a tyre" />);
    expect(screen.queryByRole("search")).toBeNull();
    expect(screen.getByRole("searchbox").parentElement).not.toHaveAttribute("role");
  });

  it("is a search landmark around the box when asked", () => {
    render(<SearchInput label="Find a tyre" landmark />);
    const box = screen.getByRole("searchbox", { name: "Find a tyre" });
    expect(screen.getByRole("search")).toBe(box.parentElement);
    expect(box).not.toHaveAttribute("landmark");
  });

  it("takes the glove size", () => {
    render(<SearchInput label="Find a vehicle" size="glove" />);
    expect(screen.getByRole("searchbox").parentElement).toHaveClass("tr-input", "tr-input--glove");
  });
});
