import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Timeline } from "./Timeline";

describe("Timeline", () => {
  it("lists events in the order given, each with its time, title and detail", () => {
    render(
      <Timeline
        aria-label="Tyre history"
        items={[
          { id: "e1", when: "12 Oct 2026", title: "Fitted to TRK-01", tone: "ok" },
          {
            id: "e2",
            when: "20 Oct 2026",
            title: "Read 3.0 mm",
            detail: "Below policy",
            tone: "critical",
          },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Tyre history" });
    expect(list.tagName).toBe("OL");
    const [first, second] = within(list).getAllByRole("listitem");
    expect(first).toHaveTextContent("12 Oct 2026Fitted to TRK-01");
    expect(second).toHaveTextContent("Below policy");
    // The dot draws the tone; the words carry it, so the dot is hidden.
    expect(second.querySelector(".tr-timeline__dot")).toHaveAttribute("aria-hidden", "true");
    expect(second.querySelector(".tr-timeline__dot--critical svg")).not.toBeNull();
  });
});
