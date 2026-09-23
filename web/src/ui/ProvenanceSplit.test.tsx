import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProvenanceSplit } from "./ProvenanceSplit";

describe("ProvenanceSplit", () => {
  it("draws one bar whose segments are proportional to the counts, with a legend of counts", () => {
    render(
      <ProvenanceSplit
        caption="Casing value provenance"
        segments={[
          { key: "actual", label: "Actual", count: 1 },
          { key: "audit", label: "Audit", count: 2 },
          { key: "unvalued", label: "Unvalued", count: 1 },
        ]}
      />,
    );
    const bar = screen.getByRole("img", {
      name: "Casing value provenance: Actual 1, Audit 2, Unvalued 1",
    });
    const segments = bar.querySelectorAll("[data-segment]");
    expect(segments).toHaveLength(3);
    expect((segments[1] as HTMLElement).style.width).toBe("50%");
    expect(screen.getByRole("list", { name: "Casing value provenance" })).toBeInTheDocument();
    expect(screen.getByText("Audit")).toBeInTheDocument();
    expect(screen.getAllByText("2")).not.toHaveLength(0);
  });

  it("says so when every count is zero instead of drawing an empty bar", () => {
    render(
      <ProvenanceSplit
        caption="Tread value provenance"
        segments={[
          { key: "actual", label: "Actual", count: 0 },
          { key: "estimated", label: "Estimated", count: 0 },
        ]}
      />,
    );
    expect(screen.getByText("No tyres to split.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
