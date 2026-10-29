import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Link, MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { forceMatchMedia } from "../test/media";
import { DataTable, type Column } from "./DataTable";
import tableCss from "./DataTable.css?raw";

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

// A cell with its own link and button, as today's tyre rows carry "Price
// it on its receipt" (e2e/tyres.spec.ts:46).
function withControls(onHold: (id: string) => void): Column<Row>[] {
  return [
    ...columns,
    {
      key: "act",
      header: "Action",
      render: (r) => (
        <>
          <Link to={`/receipts/${r.id}`}>Price it on its receipt</Link>
          <button type="button" onClick={() => onHold(r.id)}>
            Hold {r.unit}
          </button>
        </>
      ),
    },
  ];
}

function renderClickable(onRowClick: (row: Row) => void, onHold: (id: string) => void) {
  return render(
    <MemoryRouter>
      <Routes>
        <Route
          path="/"
          element={
            <DataTable
              {...base}
              columns={withControls(onHold)}
              rows={rows}
              onRowClick={onRowClick}
            />
          }
        />
        <Route path="/receipts/:id" element={<p>Receipt page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

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

  it("leaves a button inside a clickable row to its own action, on click, Space and Enter", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    const onHold = vi.fn();
    renderClickable(onRowClick, onHold);
    const hold = screen.getByRole("button", { name: "Hold TRK-01" });
    await user.click(hold);
    hold.focus();
    await user.keyboard(" ");
    await user.keyboard("{Enter}");
    expect(onHold).toHaveBeenCalledTimes(3);
    expect(onHold).toHaveBeenLastCalledWith("t1");
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("leaves a link inside a clickable row to open itself on click", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderClickable(onRowClick, vi.fn());
    await user.click(screen.getAllByRole("link", { name: "Price it on its receipt" })[0]);
    expect(await screen.findByText("Receipt page")).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("leaves a link inside a clickable row to open itself on Enter", async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderClickable(onRowClick, vi.fn());
    screen.getAllByRole("link", { name: "Price it on its receipt" })[1].focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Receipt page")).toBeInTheDocument();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("opens a row from its card title on a phone", async () => {
    const restore = forceMatchMedia(true);
    try {
      const user = userEvent.setup();
      const onRowClick = vi.fn();
      render(<DataTable {...base} rows={rows} onRowClick={onRowClick} cardHeadingLevel={2} />);
      const heading = screen.getByRole("heading", { level: 2, name: "TRL-02" });
      const card = heading.closest("li");
      expect(card).not.toBeNull();
      await user.click(within(card as HTMLElement).getByRole("button", { name: "TRL-02" }));
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

  it("a rowHeader column renders th scope=row on desktop", () => {
    const cols = columns.map((c) => ({ ...c, rowHeader: c.key === "unit" || c.key === "tread" }));
    render(<DataTable {...base} columns={cols} rows={rows} />);
    const header = screen.getByRole("rowheader", { name: "TRK-01" });
    expect(header.tagName).toBe("TH");
    expect(header).toHaveAttribute("scope", "row");
    expect(header).toHaveAttribute("data-nowrap", "true");
    expect(screen.queryByRole("rowheader", { name: "2.0 mm" })).toBeNull();
    expect(screen.getByRole("cell", { name: "2.0 mm" })).toBeInTheDocument();
  });

  it("renders no status line unless loading", () => {
    render(<DataTable {...base} rows={rows} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("renders its status line while loading", () => {
    const { rerender } = render(<DataTable {...base} rows={rows} loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading Tyres at risk");
    rerender(<DataTable {...base} rows={rows} loading={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("");
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

    it("leaves a link or button in a card's terms to its own action", async () => {
      const user = userEvent.setup();
      const onRowClick = vi.fn();
      const onHold = vi.fn();
      renderClickable(onRowClick, onHold);
      await user.click(screen.getByRole("button", { name: "Hold TRL-02" }));
      expect(onHold).toHaveBeenCalledWith("t2");
      await user.click(screen.getAllByRole("link", { name: "Price it on its receipt" })[0]);
      expect(await screen.findByText("Receipt page")).toBeInTheDocument();
      expect(onRowClick).not.toHaveBeenCalled();
    });

    // A control in the first column is the title's, not the card button's:
    // interactive content inside a button is invalid, and its click would
    // open the row as well.
    it("leaves a link in the card's title to its own action, outside the card's button", async () => {
      const user = userEvent.setup();
      const onRowClick = vi.fn();
      const linked: Column<Row>[] = [
        {
          key: "unit",
          header: "Unit",
          render: (r) => <Link to={`/receipts/${r.id}`}>{r.unit}</Link>,
        },
        ...columns.slice(1),
      ];
      render(
        <MemoryRouter>
          <Routes>
            <Route
              path="/"
              element={<DataTable {...base} columns={linked} rows={rows} onRowClick={onRowClick} />}
            />
            <Route path="/receipts/:id" element={<p>Receipt page</p>} />
          </Routes>
        </MemoryRouter>,
      );
      const link = screen.getByRole("link", { name: "TRL-02" });
      expect(link.closest("button")).toBeNull();
      const open = screen.getByRole("button", { name: "TRL-02" });
      expect(open).toBeEmptyDOMElement();
      await user.click(open);
      expect(onRowClick).toHaveBeenCalledExactlyOnceWith(rows[1]);

      await user.click(link);
      expect(await screen.findByText("Receipt page")).toBeInTheDocument();
      expect(onRowClick).toHaveBeenCalledTimes(1);
    });

    // jsdom lays nothing out, so the card's tap target is read from the
    // source: the button covers the title row, which is the 44px floor tall
    // (NFR-USE-004), never the terms under it, and a control in the title
    // sits above it.
    it("keeps the title's tap target off the card's terms", () => {
      const bare = tableCss.replace(/\/\*[\s\S]*?\*\//g, "");
      expect(bare).not.toMatch(/\.tr-tcards__hit::after/);
      expect(bare).toMatch(
        /\.tr-tcards__head \{[^}]*position: relative;[^}]*min-height: var\(--target-min\);/,
      );
      expect(bare).toMatch(/\.tr-tcards__hit \{[^}]*position: absolute;[^}]*inset: 0;/);
      expect(bare).toMatch(
        /\.tr-tcards__title\s+:is\(a, [^)]*\) \{[^}]*position: relative;[^}]*z-index: 1;/,
      );
    });

    it("shows the caption over the cards when asked to", () => {
      render(<DataTable {...base} rows={rows} captionVisible />);
      expect(screen.getByRole("list", { name: "Tyres at risk" })).toBeInTheDocument();
      expect(screen.getByText("Tyres at risk", { selector: "p" })).not.toHaveClass("tr-vh");
    });
  });
});
