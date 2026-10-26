import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { forceMatchMedia } from "../test/media";
import { BandChart, type Band } from "./BandChart";

// Labels as the dashboard writes them from each band's bounds (U40).
const bands: Band[] = [
  { label: "0 to under 5 mm", count: 10, pctOfGroup: 37.04 },
  { label: "5 to under 8 mm", count: 4, pctOfGroup: 14.81 },
  { label: "8 to under 11 mm", count: 6, pctOfGroup: 22.22 },
  { label: "11 to under 14 mm", count: 1, pctOfGroup: 3.7 },
  { label: "14 mm and over", count: 6, pctOfGroup: 22.22 },
];

const TITLE = "Tread depth across running positions";

function bars(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".tr-bands__bar"));
}

describe("BandChart", () => {
  it("BandChart bar names carry count and percentage", () => {
    render(<BandChart title={TITLE} bands={bands} data-testid="chart" />);
    const chart = screen.getByRole("figure", { name: TITLE });
    expect(chart).toHaveAttribute("data-testid", "chart");
    const named = within(chart).getAllByRole("img");
    expect(named.map((b) => b.getAttribute("aria-label"))).toEqual([
      "0 to under 5 mm: 10 tyres, 37%",
      "5 to under 8 mm: 4 tyres, 15%",
      "8 to under 11 mm: 6 tyres, 22%",
      "11 to under 14 mm: 1 tyre, 4%",
      "14 mm and over: 6 tyres, 22%",
    ]);
    // No band limit unless the caller passes one: the wire carries none.
    expect(chart.querySelector(".tr-bands__limit")).toBeNull();
  });

  it("BandChart keeps a table behind the chart", async () => {
    const user = userEvent.setup();
    render(<BandChart title={TITLE} bands={bands} />);
    // jsdom keeps a closed disclosure's content in the tree, so the closed
    // state is read from the element itself.
    const disclosure = screen.getByText("Show as table").closest("details");
    expect(disclosure).not.toHaveAttribute("open");
    await user.click(screen.getByText("Show as table"));
    expect(disclosure).toHaveAttribute("open");
    const table = screen.getByRole("table", { name: TITLE });
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getByRole("cell", { name: "11 to under 14 mm" })).toBeInTheDocument();
    expect(within(table).getAllByRole("cell", { name: "22%" })).toHaveLength(2);
  });

  // U46 up to five bands, U56 above: colour reaches a bar only through the
  // --data-N custom properties, with the nearest stop as the fallback.
  it("fills each bar from the ramp, blending between stops above five bands", () => {
    const { unmount } = render(<BandChart title={TITLE} bands={bands} />);
    expect(bars().map((b) => b.style.getPropertyValue("--tr-band-fill"))).toEqual([
      "var(--data-1)",
      "var(--data-2)",
      "var(--data-3)",
      "var(--data-4)",
      "var(--data-5)",
    ]);
    unmount();

    const seven = Array.from({ length: 7 }, (_, i) => ({
      label: `Band ${i + 1}`,
      count: i + 1,
      pctOfGroup: 10,
    }));
    render(<BandChart title={TITLE} bands={seven} />);
    const fills = bars().map((b) => b.style.getPropertyValue("--tr-band-fill"));
    expect(new Set(fills).size).toBe(7);
    expect(fills[1]).toContain("color-mix(");
    expect(bars().map((b) => b.style.getPropertyValue("--tr-band-fallback"))).toEqual([
      "var(--data-1)",
      "var(--data-2)",
      "var(--data-2)",
      "var(--data-3)",
      "var(--data-4)",
      "var(--data-4)",
      "var(--data-5)",
    ]);
  });

  it("sizes each bar against the largest band", () => {
    render(<BandChart title={TITLE} bands={bands} />);
    expect(bars().map((b) => b.style.width)).toEqual(["100%", "40%", "60%", "10%", "60%"]);
  });

  it("renders one row per band below 640px, each still named", () => {
    const restore = forceMatchMedia(true);
    try {
      render(<BandChart title={TITLE} bands={bands} />);
      const chart = screen.getByRole("figure", { name: TITLE });
      expect(chart).toHaveAttribute("data-form", "rows");
      expect(within(chart).getAllByRole("img")).toHaveLength(5);
      expect(
        within(chart).getByRole("img", { name: "0 to under 5 mm: 10 tyres, 37%" }),
      ).toBeInTheDocument();
    } finally {
      restore();
    }
    render(<BandChart title="Desk" bands={bands} />);
    expect(screen.getByRole("figure", { name: "Desk" })).toHaveAttribute("data-form", "inline");
  });

  it("draws the caller's limit after the bands at or below it", () => {
    render(
      <BandChart
        title={TITLE}
        bands={bands}
        limitBefore={1}
        limitLabel="Sample removal threshold"
      />,
    );
    const limit = screen.getByText("Sample removal threshold");
    const rows = screen.getAllByRole("img");
    expect(rows[0]).toHaveAttribute("data-limit", "true");
    expect(rows[1]).not.toHaveAttribute("data-limit");
    expect(rows[0].compareDocumentPosition(limit)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(limit.compareDocumentPosition(rows[1])).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("says so when every band is empty", () => {
    render(
      <BandChart title={TITLE} bands={bands.map((b) => ({ ...b, count: 0, pctOfGroup: 0 }))} />,
    );
    expect(screen.getByText("No tyres in any band.")).toBeInTheDocument();
    expect(screen.queryByRole("figure")).toBeNull();
  });
});
