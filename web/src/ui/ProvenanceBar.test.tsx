import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProvenanceBar } from "./ProvenanceBar";

describe("ProvenanceBar", () => {
  // NFR-PRO-002: the bar's name carries every label and count in words, so
  // the legend is hidden and each is heard once.
  it("names the bar with every segment and hides the legend", () => {
    render(
      <ProvenanceBar
        caption="How the value at risk was valued"
        segments={[
          { key: "actual", label: "actual", count: 0 },
          { key: "audit", label: "audit", count: 9 },
          { key: "estimated", label: "estimated", count: 1200 },
          { key: "unvalued", label: "not valued", count: 2 },
        ]}
        data-testid="split"
      />,
    );
    const bar = screen.getByRole("img", {
      name: "How the value at risk was valued: actual 0, audit 9, estimated 1,200, not valued 2",
    });
    expect(bar.closest("figure")).toHaveAttribute("data-testid", "split");
    // A zero segment draws nothing but keeps its legend entry.
    const drawn = Array.from(bar.children, (s) => s.getAttribute("data-segment"));
    expect(drawn).toEqual(["audit", "estimated", "unvalued"]);
    expect(bar.querySelector("[data-segment='estimated']")).toHaveStyle({ flexGrow: "1200" });
    const legend = screen.getByText("estimated").closest("ul");
    expect(legend).toHaveAttribute("aria-hidden", "true");
    expect(legend?.querySelectorAll("li")).toHaveLength(4);
  });

  it("says so when there is nothing to split", () => {
    render(
      <ProvenanceBar caption="Valued" segments={[{ key: "audit", label: "audit", count: 0 }]} />,
    );
    expect(screen.getByText("No tyres to split.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
