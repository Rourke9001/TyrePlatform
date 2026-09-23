import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forceMatchMedia } from "../test/media";
import { BandChart } from "./BandChart";

const bands = [
  { bandOrdinal: 1, lowerMm: 0, upperExclusiveMm: 5, tyreCount: 10, pctOfGroup: 37.04 },
  { bandOrdinal: 2, lowerMm: 5, upperExclusiveMm: 8, tyreCount: 4, pctOfGroup: 14.81 },
  { bandOrdinal: 3, lowerMm: 8, upperExclusiveMm: 11, tyreCount: 6, pctOfGroup: 22.22 },
  { bandOrdinal: 4, lowerMm: 11, upperExclusiveMm: 14, tyreCount: 5, pctOfGroup: 18.52 },
  { bandOrdinal: 5, lowerMm: 14, upperExclusiveMm: null, tyreCount: 2, pctOfGroup: 7.41 },
];

// The wire's own label for the first band, which names a range the band
// does not cover (TYRE-270).
const wireBands = bands.map((b) => (b.bandOrdinal === 1 ? { ...b, bandLabel: "0-4mm" } : b));

const PLOT = "Tread depth across running positions, 5 bands";

describe("BandChart", () => {
  // U40: the words come from the bounds; TYRE-270's bandLabel never renders.
  it("labels every bar from its bounds and puts the count on the bar", () => {
    render(<BandChart title="Tread depth across running positions" bands={wireBands} />);
    const chart = screen.getByRole("figure", { name: "Tread depth across running positions" });
    expect(
      within(chart).getByRole("img", { name: "0 to under 5 mm: 10 tyres, 37%" }),
    ).toBeInTheDocument();
    expect(
      within(chart).getByRole("img", { name: "14 mm and over: 2 tyres, 7%" }),
    ).toBeInTheDocument();
    expect(within(within(chart).getByRole("group", { name: PLOT })).getByText("10")).toHaveClass(
      "band-chart-count",
    );
    expect(within(chart).queryByText("0-4mm")).toBeNull();
    expect(chart.querySelector("[data-form='columns']")).not.toBeNull();
    expect(chart.querySelector("[data-form='rows']")).toBeNull();
  });

  it("offers the same numbers as a table", async () => {
    render(<BandChart title="Tread depth across running positions" bands={bands} />);
    await userEvent.click(screen.getByText("Show as table"));
    const table = screen.getByRole("table", { name: "Tread depth across running positions" });
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getByRole("cell", { name: "11 to under 14 mm" })).toBeInTheDocument();
  });

  // The hover layer (dataviz, step 5). jsdom does not reliably focus an
  // SVG group, so the pointer path is the one driven here and the keyboard
  // path shares the same handlers.
  it("shows a tooltip on hover and hides it on leave", async () => {
    const user = userEvent.setup();
    render(<BandChart title="Tread depth across running positions" bands={bands} />);
    const bar = screen.getByRole("img", { name: "5 to under 8 mm: 4 tyres, 15%" });
    await user.hover(bar);
    expect(screen.getByRole("tooltip")).toHaveTextContent("4 tyres");
    await user.unhover(bar);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("says so when every band is empty", () => {
    render(
      <BandChart
        title="Tread depth"
        bands={bands.map((b) => ({ ...b, tyreCount: 0, pctOfGroup: 0 }))}
      />,
    );
    expect(screen.getByText("No tyres in any band.")).toBeInTheDocument();
  });

  describe("on a phone", () => {
    let restore: () => void;

    beforeEach(() => {
      restore = forceMatchMedia(true);
    });

    afterEach(() => {
      restore();
    });

    // TYRE-238 comment 12938 and the accepted mockup: five bound labels cannot sit side by
    // side at 390, so below the breakpoint the chart is one row per band.
    it("turns into one row per band on a phone, each still labelled from its bounds", () => {
      render(<BandChart title="Tread depth across running positions" bands={bands} />);
      const chart = screen.getByRole("figure", { name: "Tread depth across running positions" });
      const rows = within(chart).getAllByRole("img");
      expect(rows).toHaveLength(5);
      expect(rows[0]).toHaveAccessibleName("0 to under 5 mm: 10 tyres, 37%");
      const plot = within(chart).getByRole("group", { name: PLOT });
      expect(within(plot).getByText("0 to under 5 mm")).toHaveClass("band-chart-axis");
      expect(within(plot).getByText("10")).toHaveClass("band-chart-count");
      expect(chart.querySelector("[data-form='rows']")).not.toBeNull();
      expect(chart.querySelector("[data-form='columns']")).toBeNull();
    });
  });
});
