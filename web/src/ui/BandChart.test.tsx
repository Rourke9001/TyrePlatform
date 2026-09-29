import { act, createEvent, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forceMatchMedia, TestMediaQueryList } from "../test/media";
import { BandChart } from "./BandChart";
import { PHONE_QUERY } from "./useMediaQuery";

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

  // Colour reaches the SVG only through the --band-N custom properties
  // (TYRE-238 review); a hex written to the fill attribute is a bug.
  it("paints each bar through a --band-N custom property, never a hex", () => {
    render(<BandChart title="Tread depth across running positions" bands={bands} />);
    const bars = document.querySelectorAll<SVGPathElement>(".band-chart-svg path");
    expect(bars[0].style.fill).toBe("var(--band-1)");
    expect(bars[bars.length - 1].style.fill).toBe("var(--band-5)");
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

  // A keyboard user tabs to a band (focus), the pointer then crosses a
  // different band and leaves the chart: the focused band's tooltip must
  // come back, not stay stuck on null. fireEvent drives focus/blur directly
  // because jsdom does not reliably tab-focus an SVG group.
  it("keeps a focused band's tooltip after the pointer crosses and leaves another band", async () => {
    const user = userEvent.setup();
    render(<BandChart title="Tread depth across running positions" bands={bands} />);
    const band2 = screen.getByRole("img", { name: "5 to under 8 mm: 4 tyres, 15%" });
    const band4 = screen.getByRole("img", { name: "11 to under 14 mm: 5 tyres, 19%" });

    fireEvent.focus(band2);
    expect(screen.getByRole("tooltip")).toHaveTextContent("4 tyres");

    await user.hover(band4);
    expect(screen.getByRole("tooltip")).toHaveTextContent("5 tyres");

    await user.unhover(band4);
    expect(screen.getByRole("tooltip")).toHaveTextContent("4 tyres");
  });

  // Every browser focuses an SVG group on mousedown, which jsdom will not
  // reproduce, so this asserts the suppression mechanism instead: without
  // it, a clicked band keeps its tooltip after the pointer leaves (TYRE-238
  // review).
  it("suppresses the mousedown default so clicking a band cannot take keyboard focus", () => {
    render(<BandChart title="Tread depth across running positions" bands={bands} />);
    const band = screen.getByRole("img", { name: "5 to under 8 mm: 4 tyres, 15%" });
    const event = createEvent.mouseDown(band);
    fireEvent(band, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("clears the tooltip on blur when no band is hovered", () => {
    render(<BandChart title="Tread depth across running positions" bands={bands} />);
    const band1 = screen.getByRole("img", { name: "0 to under 5 mm: 10 tyres, 37%" });

    fireEvent.focus(band1);
    expect(screen.getByRole("tooltip")).toHaveTextContent("10 tyres");

    fireEvent.blur(band1);
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

  // U56: above five bands every bar gets its own fill, still through the
  // --band-N custom properties.
  it("gives each of seven bands its own fill through the custom properties", () => {
    const seven = [0, 3, 5, 7, 9, 11, 14].map((lowerMm, i, all) => ({
      bandOrdinal: i + 1,
      lowerMm,
      upperExclusiveMm: all[i + 1] ?? null,
      tyreCount: 2 + i,
      pctOfGroup: 10,
    }));
    render(<BandChart title="Tread depth across running positions" bands={seven} />);
    const fills = Array.from(document.querySelectorAll<SVGPathElement>(".band-chart-svg path")).map(
      (p) => p.style.fill,
    );
    expect(new Set(fills).size).toBe(7);
    expect(fills.every((f) => f.includes("var(--band-"))).toBe(true);
    // The fallback a browser without color-mix inherits (U56): each bar's
    // group carries its nearest stop.
    const groups = Array.from(
      document.querySelectorAll<SVGGElement>(".band-chart-svg .band-chart-bar"),
    );
    expect(groups.map((g) => g.style.fill)).toEqual([
      "var(--band-1)",
      "var(--band-2)",
      "var(--band-2)",
      "var(--band-3)",
      "var(--band-4)",
      "var(--band-4)",
      "var(--band-5)",
    ]);
  });

  // TYRE-275: every count sits inside the plot, so the tooltip sits above
  // it, following its column across. The middle band of five is centred at
  // exactly half the width.
  it("places the tooltip above the plot, following its column", async () => {
    const user = userEvent.setup();
    render(<BandChart title="Tread depth across running positions" bands={bands} />);
    await user.hover(screen.getByRole("img", { name: "8 to under 11 mm: 6 tyres, 22%" }));
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip).toHaveAttribute("data-form", "columns");
    expect(tooltip.style.left).toBe("50%");
  });

  // TYRE-275: a width change across 640px while a band is active leaves no
  // tooltip over the other form.
  // The spy is restored in finally: a failed assertion would otherwise leave
  // matchMedia answering phone for every later test in the file.
  it("clears the tooltip when the form switches", async () => {
    const list = new TestMediaQueryList(PHONE_QUERY, false);
    const spy = vi.spyOn(window, "matchMedia").mockReturnValue(list);
    try {
      const user = userEvent.setup();
      render(<BandChart title="Tread depth across running positions" bands={bands} />);
      await user.hover(screen.getByRole("img", { name: "5 to under 8 mm: 4 tyres, 15%" }));
      expect(screen.getByRole("tooltip")).toBeInTheDocument();
      act(() => {
        list.change(true);
      });
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  // TYRE-275: a bar narrower than twice the radius keeps a flat top rather
  // than a path that doubles back on itself. 56 bands make every figure a
  // whole unit (slot 10, bar 6, x 2), so the clamped radius of 3 puts both
  // ends at exactly 5; the unclamped 4 would end the run at 4, before the arc.
  it("clamps the column radius by the bar's width", () => {
    const many = Array.from({ length: 56 }, (_, i) => ({
      bandOrdinal: i + 1,
      lowerMm: i,
      upperExclusiveMm: i + 1,
      tyreCount: 5,
      pctOfGroup: 1,
    }));
    render(<BandChart title="Tread depth across running positions" bands={many} />);
    const d =
      document.querySelector<SVGPathElement>(".band-chart-svg path")?.getAttribute("d") ?? "";
    const [, arcEnd, runEnd] = /Q \S+ \S+ (\S+) \S+ H (\S+)/.exec(d) ?? [];
    expect(Number(runEnd)).toBeGreaterThanOrEqual(Number(arcEnd));
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

    it("puts a row's tooltip above the plot, not beside the row's count", async () => {
      const user = userEvent.setup();
      render(<BandChart title="Tread depth across running positions" bands={bands} />);
      await user.hover(screen.getByRole("img", { name: "0 to under 5 mm: 10 tyres, 37%" }));
      const tooltip = screen.getByRole("tooltip");
      expect(tooltip).toHaveAttribute("data-form", "rows");
      expect(tooltip.style.top).toBe("");
    });
  });
});
