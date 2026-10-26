import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { FilterBar } from "./FilterBar";

describe("FilterBar", () => {
  it("groups the filters and puts a refresh beside them", async () => {
    const onRefresh = vi.fn();
    render(
      <FilterBar onRefresh={onRefresh}>
        <label>
          Depot <select aria-label="Depot" />
        </label>
      </FilterBar>,
    );
    const group = screen.getByRole("group", { name: "Filters" });
    expect(group).toContainElement(screen.getByRole("combobox", { name: "Depot" }));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("keeps the refresh focusable but inert while one is in flight, and says so", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    render(
      <FilterBar onRefresh={onRefresh} refreshing>
        <span />
      </FilterBar>,
    );
    const button = screen.getByRole("button", { name: "Refreshing" });
    expect(button).toHaveAttribute("aria-disabled", "true");
    await user.click(button);
    await user.keyboard("{Enter}");
    expect(onRefresh).not.toHaveBeenCalled();
    expect(button).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing");
  });
});
