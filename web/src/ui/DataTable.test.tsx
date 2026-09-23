import { render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { forceMatchMedia } from "../test/media";
import { DataTable, type Column } from "./DataTable";

interface Row {
  id: string;
  unit: string;
  tread: string;
  basis: string;
}

const columns: Column<Row>[] = [
  { key: "unit", header: "Unit", cell: (r) => r.unit },
  { key: "tread", header: "Tread", align: "right", cell: (r) => r.tread },
  { key: "basis", header: "Basis", basis: true, cell: (r) => r.basis },
];

describe("DataTable", () => {
  it("renders the caption, the headers and right-aligned numerics", () => {
    render(
      <DataTable
        caption="Tyres at risk"
        columns={columns}
        rows={[{ id: "t1", unit: "HORSE", tread: "2.0 mm", basis: "audit valuation" }]}
        rowKey={(r) => r.id}
        empty={<p>none</p>}
      />,
    );
    const table = screen.getByRole("table", { name: "Tyres at risk" });
    expect(within(table).getByRole("columnheader", { name: "Tread" })).toHaveClass("cell-right");
    expect(within(table).getByRole("cell", { name: "2.0 mm" })).toHaveClass("cell-right");
    expect(within(table).getByRole("cell", { name: "audit valuation" })).toHaveClass("cell-basis");
  });

  it("renders the empty state instead of an empty table", () => {
    render(
      <DataTable
        caption="Tyres at risk"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<p>none</p>}
      />,
    );
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText("none")).toBeInTheDocument();
  });

  it("marks itself busy while loading and shows skeleton rows", () => {
    render(
      <DataTable
        caption="Tyres at risk"
        columns={columns}
        rows={[]}
        rowKey={(r) => r.id}
        empty={<p>none</p>}
        loading
      />,
    );
    const table = screen.getByRole("table", { name: "Tyres at risk" });
    expect(table).toHaveAttribute("aria-busy", "true");
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(screen.queryByText("none")).toBeNull();
  });

  describe("on a phone", () => {
    const rows: Row[] = [
      { id: "t1", unit: "HORSE", tread: "2.0 mm", basis: "audit valuation" },
      { id: "t2", unit: "LINK1", tread: "3.5 mm", basis: "estimated" },
    ];
    let restore: () => void;

    beforeEach(() => {
      restore = forceMatchMedia(true);
    });

    afterEach(() => {
      restore();
    });

    it("renders one card per row in a list named by the caption, not a table", () => {
      render(
        <DataTable
          caption="Tyres at risk"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={<p>none</p>}
        />,
      );
      expect(screen.queryByRole("table")).toBeNull();
      const list = screen.getByRole("list", { name: "Tyres at risk" });
      expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    });

    it("heads each card with the first column at level 3 by default", () => {
      render(
        <DataTable
          caption="Tyres at risk"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={<p>none</p>}
        />,
      );
      const [first, second] = within(
        screen.getByRole("list", { name: "Tyres at risk" }),
      ).getAllByRole("listitem");
      expect(within(first).getByRole("heading", { level: 3, name: "HORSE" })).toBeInTheDocument();
      expect(within(second).getByRole("heading", { level: 3, name: "LINK1" })).toBeInTheDocument();
    });

    it("takes the heading level from the caller", () => {
      render(
        <DataTable
          caption="Tyres at risk"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={<p>none</p>}
          cardHeadingLevel={2}
        />,
      );
      expect(screen.getByRole("heading", { level: 2, name: "HORSE" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    });

    it("sets every other column as a term beside its value, keeping the cell classes", () => {
      render(
        <DataTable
          caption="Tyres at risk"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          empty={<p>none</p>}
        />,
      );
      const [card] = within(screen.getByRole("list", { name: "Tyres at risk" })).getAllByRole(
        "listitem",
      );
      const terms = card.querySelectorAll("dt");
      expect(Array.from(terms, (t) => t.textContent)).toEqual(["Tread", "Basis"]);

      const tread = within(card).getByText("Tread", { selector: "dt" }).nextElementSibling;
      expect(tread?.tagName).toBe("DD");
      expect(tread).toHaveTextContent("2.0 mm");
      expect(tread).toHaveClass("cell-right");

      const basis = within(card).getByText("Basis", { selector: "dt" }).nextElementSibling;
      expect(basis?.tagName).toBe("DD");
      expect(basis).toHaveTextContent("audit valuation");
      expect(basis).toHaveClass("cell-basis");
    });

    it("marks the list busy and shows four skeleton cards while loading", () => {
      render(
        <DataTable
          caption="Tyres at risk"
          columns={columns}
          rows={[]}
          rowKey={(r) => r.id}
          empty={<p>none</p>}
          loading
        />,
      );
      const list = screen.getByRole("list", { name: "Tyres at risk" });
      expect(list).toHaveAttribute("aria-busy", "true");
      expect(within(list).getAllByRole("listitem")).toHaveLength(4);
      expect(screen.queryByText("none")).toBeNull();
    });

    it("renders the empty state instead of an empty list", () => {
      render(
        <DataTable
          caption="Tyres at risk"
          columns={columns}
          rows={[]}
          rowKey={(r) => r.id}
          empty={<p>none</p>}
        />,
      );
      expect(screen.queryByRole("list")).toBeNull();
      expect(screen.getByText("none")).toBeInTheDocument();
    });
  });
});
