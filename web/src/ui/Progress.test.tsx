import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Progress } from "./Progress";

describe("Progress", () => {
  it("is a progress bar named by its label, counting every segment", () => {
    render(
      <Progress
        label="Positions read"
        segments={[
          { label: "TRK-01", done: 6, total: 6 },
          { label: "TRL-02", done: 2, total: 12 },
        ]}
      />,
    );
    const bar = screen.getByRole("progressbar", { name: "Positions read" });
    expect(bar).toHaveAttribute("aria-valuenow", "8");
    expect(bar).toHaveAttribute("aria-valuemax", "18");
    expect(bar).toHaveAttribute("aria-valuetext", "8 of 18");
    expect(screen.getByText("8 of 18")).toBeInTheDocument();
    expect(screen.getByText("TRK-01").parentElement).toHaveTextContent("TRK-01 done");
    expect(screen.getByText("TRL-02").parentElement).toHaveTextContent("TRL-02 10 left");
  });

  it("draws no legend for a single segment", () => {
    render(<Progress label="Positions read" segments={[{ label: "TRK-01", done: 1, total: 6 }]} />);
    expect(screen.queryByText("TRK-01")).toBeNull();
  });
});
