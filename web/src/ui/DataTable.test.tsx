import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forceMatchMedia } from "../test/media";
import { DataTable, type Column } from "./DataTable";

interface Row {
  id: string;
  unit: string;
  tread: string;
  basis: string;
}

const columns: Column<Row>[] = [
  { key: "unit", header: "Unit", render: (r) => r.unit, nowrap: true },
  { key: "tread", header: "Tread", align: "right", mono: true, render: (r) => r.tread },
  { key: "basis", header: "Basis", basis: true, render: (r) => r.basis },
];

const rows: Row[] = [
  { id: "t1", unit: "TRK-01", tread: "2.0 mm", basis: "audit valuation" },
  { id: "t2", unit: "TRL-02", tread: "3.5 mm", basis: "estimated" },
];

const base = { caption: "Tyres at risk", columns, rowKey: (r: Row) => r.id };

describe("DataTable", () => {
  it("DataTable renders a table at desktop and cards below 640px", () => {
    const { unmount } = render(
      <DataTable {...base} rows={rows} empty={<p>none</p>} data-testid="at-risk" />,
    );
    const table = screen.getByRole("table", { name: "Tyres at risk" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByRole("columnheader", { name: "Tread" })).toHaveAttribute(
      "data-align",
      "right",
    );
    const tread = within(table).getByRole("cell", { name: "2.0 mm" });
    expect(tread).toHaveAttribute("data-align", "right");
    expect(tread).toHaveAttribute("data-mono", "true");
    expect(within(table).getByRole("cell", { name: "audit valuation" })).toHaveAttribute(
      "data-basis",
      "true",
    );
    expect(screen.getByTestId("at-risk")).toContainElement(table);
    // The caption names the table and is not drawn: the page titles it.
    expect(table.querySelector("caption")).toHaveClass("tr-vh");
    expect(screen.queryByRole("list")).toBeNull();
    unmount();

    const restore = forceMatchMedia(true);
    try {
      render(<DataTable {...base} rows={rows} empty={<p>none</p>} />);
      expect(screen.queryByRole("table")).toBeNull();
      const list = screen.getByRole("list", { name: "Tyres at risk" });
      const cards = within(list).getAllByRole("listitem");
      expect(cards).toHaveLength(2);
      expect(within(cards[0]).getByRole("heading", { level: 3, name: "TRK-01" })).toBeVisible();
      const terms = Array.from(cards[0].querySelectorAll("dt"), (t) => t.textContent);
      expect(terms).toEqual(["Tread", "Basis"]);
      const value = within(cards[0]).getByText("Tread", { selector: "dt" }).nextElementSibling;
      expect(value).toHaveTextContent("2.0 mm");
      expect(value).toHaveAttribute("data-mono", "true");
    } finally {
      restore();
    }
  });

  it("DataTable row opens on Enter and Space", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(
      <DataTable
        {...base}
        rows={rows}
        onRowClick={onRowClick}
        selectedKey="t2"
        rowTone={(r) => (r.id === "t1" ? "critical" : undefined)}
      />,
    );
    const [, first, second] = screen.getAllByRole("row");
    expect(first).toHaveAttribute("data-tone", "critical");
    expect(second).toHaveAttribute("aria-current", "true");
    expect(first).not.toHaveAttribute("aria-current");

    await user.tab();
    expect(first).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);
    await user.tab();
    expect(second).toHaveFocus();
    await user.keyboard(" ");
    expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
    fireEvent.click(within(first).getByRole("cell", { name: "TRK-01" }));
    expect(onRowClick).toHaveBeenCalledTimes(3);
  });

  it("opens a row from its card title on a phone", async () => {
    const restore = forceMatchMedia(true);
    try {
      const user = userEvent.setup();
      const onRowClick = vi.fn();
      render(<DataTable {...base} rows={rows} onRowClick={onRowClick} cardHeadingLevel={2} />);
      const heading = screen.getByRole("heading", { level: 2, name: "TRL-02" });
      await user.click(within(heading).getByRole("button", { name: "TRL-02" }));
      expect(onRowClick).toHaveBeenCalledWith(rows[1]);
    } finally {
      restore();
    }
  });

  it("renders the empty state instead of an empty table", () => {
    render(<DataTable {...base} rows={[]} empty={<p>none</p>} />);
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("marks itself busy while loading, shows skeleton rows and says so in a status line", () => {
    render(<DataTable {...base} rows={[]} empty={<p>none</p>} loading />);
    const table = screen.getByRole("table", { name: "Tyres at risk" });
    expect(table).toHaveAttribute("aria-busy", "true");
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Tyres at risk");
    expect(screen.queryByText("none")).toBeNull();
  });

  describe("on a phone", () => {
    let restore: () => void;
    beforeEach(() => {
      restore = forceMatchMedia(true);
    });
    afterEach(() => {
      restore();
    });

    it("marks the card list busy and shows four skeleton cards while loading", () => {
      render(<DataTable {...base} rows={[]} empty={<p>none</p>} loading />);
      const list = screen.getByRole("list", { name: "Tyres at risk" });
      expect(list).toHaveAttribute("aria-busy", "true");
      expect(within(list).getAllByRole("listitem")).toHaveLength(4);
      expect(screen.getByRole("status")).toHaveTextContent("Loading Tyres at risk");
    });

    it("shows the caption over the cards when asked to", () => {
      render(<DataTable {...base} rows={rows} captionVisible />);
      expect(screen.getByRole("list", { name: "Tyres at risk" })).toBeInTheDocument();
      expect(screen.getByText("Tyres at risk", { selector: "p" })).not.toHaveClass("tr-vh");
    });
  });
});
