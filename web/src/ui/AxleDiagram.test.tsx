import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AxleDiagram,
  type DiagramAxle,
  type DiagramPosition,
  type DiagramUnit,
} from "./AxleDiagram";

// A cell key, not a position id, is what tells two same-configuration units'
// wheels apart (BR-VEH-003), so the fixture's ids and data-position-ids
// differ on purpose.
const pos = (unit: string, n: number): DiagramPosition => ({
  id: `${unit}:${n}`,
  label: String(n),
  valueText: "—",
  badgeText: "Not done",
  ariaLabel: `Position ${n}, ${unit}`,
  dataPositionId: `${unit}-p${n}`,
  condition: "unread",
});

const axle = (unit: string, id: string, numbers: number[]): DiagramAxle => ({
  id,
  positions: numbers.map((n) => pos(unit, n)),
});

// A superlink: 26 running positions and a spare, 27 cells, 108 entries at
// three treads and a pressure each. LINK6's walk is listed high to low, so a
// component that sorts by label or id puts it back and fails.
const rig: DiagramUnit[] = [
  {
    id: "horse",
    unitHeading: "BAC039SP",
    axles: [
      axle("BAC039SP", "a1", [1, 2]),
      axle("BAC039SP", "a2", [3, 4, 5, 6]),
      axle("BAC039SP", "a3", [7, 8, 9, 10]),
    ],
    spares: [{ ...pos("BAC039SP", 0), id: "BAC039SP:S", label: "S", ariaLabel: "Spare, BAC039SP" }],
  },
  {
    id: "link6",
    unitHeading: "LINK6",
    description: "2-axle trailer",
    coupled: true,
    axles: [axle("LINK6", "b1", [18, 17, 16, 15]), axle("LINK6", "b2", [14, 13, 12, 11])],
  },
  {
    id: "link12",
    unitHeading: "LINK12",
    description: "2-axle trailer",
    coupled: true,
    axles: [axle("LINK12", "c1", [19, 20, 21, 22]), axle("LINK12", "c2", [23, 24, 25, 26])],
  },
];

const givenOrder = rig.flatMap((u) => [
  ...u.axles.flatMap((a) => a.positions),
  ...(u.spares ?? []),
]);

describe("AxleDiagram", () => {
  it("AxleDiagram renders a 27-position, three-unit rig in the given order with each unitHeading", () => {
    const { container } = render(<AxleDiagram units={rig} onSelect={vi.fn()} />);
    const tiles = Array.from(container.querySelectorAll("[data-position-id]"));
    expect(tiles).toHaveLength(27);
    expect(tiles.map((t) => t.getAttribute("data-position-id"))).toEqual(
      givenOrder.map((p) => p.dataPositionId),
    );
    expect(tiles.map((t) => t.getAttribute("aria-label"))).toEqual(
      givenOrder.map((p) => p.ariaLabel),
    );
    for (const tile of tiles) expect(tile.tagName).toBe("BUTTON");

    const headings = Array.from(container.querySelectorAll(".tr-unit__head")).map(
      (h) => h.textContent,
    );
    expect(headings).toEqual(["BAC039SP", "LINK6 2-axle trailer", "LINK12 2-axle trailer"]);
  });

  it("hands back the tapped position and its unit", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(p: DiagramPosition, u: DiagramUnit) => void>();
    render(<AxleDiagram units={rig} onSelect={onSelect} />);
    await user.click(screen.getByRole("button", { name: "Position 13, LINK6" }));
    expect(onSelect).toHaveBeenCalledOnce();
    const [position, unit] = onSelect.mock.calls[0];
    expect(position.id).toBe("LINK6:13");
    expect(unit.id).toBe("link6");
  });

  // FR-INS-060: the coupling is drawn once per coupled unit, never before a
  // group that only carries spares.
  it("draws the coupling only above a unit marked coupled", () => {
    const spareRow: DiagramUnit = {
      id: "link6-spare",
      unitHeading: "LINK6 spare",
      axles: [],
      spares: [{ ...pos("LINK6", 0), id: "LINK6:S", label: "S", ariaLabel: "Spare, LINK6" }],
    };
    const { container } = render(<AxleDiagram units={[...rig, spareRow]} />);
    expect(container.querySelectorAll(".tr-axles__hitch")).toHaveLength(2);
    expect(Array.from(container.querySelectorAll(".tr-unit__head")).at(-1)?.textContent).toBe(
      "LINK6 spare",
    );
  });

  it("shows no direction, side, axle or spare word unless the caller gives one", () => {
    const { container, rerender } = render(<AxleDiagram units={rig} />);
    expect(container).not.toHaveTextContent(/front|left|right|spare|coupled/i);

    rerender(
      <AxleDiagram
        units={[
          {
            ...rig[0],
            axles: rig[0].axles.map((a, i) => ({ ...a, label: i === 0 ? "Steer" : "Drive" })),
          },
        ]}
        frontLabel="Front"
        sideLabels={{ left: "Left", right: "Right" }}
        sparesLabel="Spare"
      />,
    );
    expect(container).toHaveTextContent("Front");
    expect(container).toHaveTextContent("Left");
    expect(container).toHaveTextContent("Steer");
    expect(container).toHaveTextContent("Spare");
  });

  it("marks the selected position with aria-pressed and the open one with data-active", () => {
    const units: DiagramUnit[] = [
      {
        ...rig[0],
        axles: [
          {
            id: "a1",
            positions: [{ ...pos("BAC039SP", 1), active: true }, pos("BAC039SP", 2)],
          },
        ],
        spares: [],
      },
    ];
    render(<AxleDiagram units={units} selectedId="BAC039SP:2" onSelect={vi.fn()} />);
    const one = screen.getByRole("button", { name: "Position 1, BAC039SP" });
    const two = screen.getByRole("button", { name: "Position 2, BAC039SP" });
    expect(one).toHaveAttribute("data-active", "true");
    expect(one).toHaveAttribute("aria-pressed", "false");
    expect(two).toHaveAttribute("aria-pressed", "true");
  });

  it("draws static tiles without onSelect and passes unknown props to its root", () => {
    const { container } = render(<AxleDiagram units={rig.slice(0, 1)} data-testid="rig" />);
    expect(container.firstElementChild).toHaveAttribute("data-testid", "rig");
    expect(within(container).queryAllByRole("button")).toHaveLength(0);
    expect(
      within(container).getByRole("img", { name: "Position 1, BAC039SP" }),
    ).toBeInTheDocument();
  });

  it("names an axle and the spares as groups only when given a label", () => {
    const units: DiagramUnit[] = [
      {
        ...rig[0],
        sparesAriaLabel: "Spares",
        axles: [
          { ...axle("BAC039SP", "a1", [1, 2]), ariaLabel: "Axle 1" },
          axle("BAC039SP", "a2", [3, 4]),
        ],
      },
    ];
    render(<AxleDiagram units={units} />);
    const named = screen.getByRole("group", { name: "Axle 1" });
    expect(within(named).getAllByRole("img")).toHaveLength(2);
    const spares = screen.getByRole("group", { name: "Spares" });
    expect(within(spares).getAllByRole("img")).toHaveLength(1);
    expect(screen.getAllByRole("group")).toHaveLength(2);
  });

  it("gives no spares group without a label", () => {
    render(<AxleDiagram units={rig.slice(0, 1)} />);
    expect(screen.queryAllByRole("group")).toHaveLength(0);
  });

  // U146: an uneven axle drew its middle tyre on the wrong side.
  it("splits an axle by each position's side when all carry one", () => {
    const sided = (n: number, side: "left" | "right"): DiagramPosition => ({
      ...pos("U", n),
      side,
    });
    const units: DiagramUnit[] = [
      {
        id: "u",
        unitHeading: "U",
        axles: [{ id: "a", positions: [sided(1, "left"), sided(2, "right"), sided(3, "right")] }],
      },
    ];
    const { container } = render(<AxleDiagram units={units} />);
    const ids = (sel: string) =>
      Array.from(container.querySelectorAll(`${sel} [data-position-id]`)).map((t) =>
        t.getAttribute("data-position-id"),
      );
    expect(ids(".tr-axle__side--left")).toEqual(["U-p1"]);
    expect(ids(".tr-axle__side--right")).toEqual(["U-p2", "U-p3"]);
  });

  it("keeps the count split when any position lacks a side", () => {
    const units: DiagramUnit[] = [
      {
        id: "u",
        unitHeading: "U",
        axles: [
          {
            id: "a",
            positions: [{ ...pos("U", 1), side: "right" }, pos("U", 2), pos("U", 3)],
          },
        ],
      },
    ];
    const { container } = render(<AxleDiagram units={units} />);
    expect(container.querySelectorAll(".tr-axle__side--left [data-position-id]")).toHaveLength(2);
  });
});
