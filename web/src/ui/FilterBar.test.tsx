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
  });

  it("disables the refresh while one is in flight", () => {
    render(
      <FilterBar onRefresh={() => undefined} refreshing>
        <span />
      </FilterBar>,
    );
    expect(screen.getByRole("button", { name: "Refreshing" })).toBeDisabled();
  });
});
