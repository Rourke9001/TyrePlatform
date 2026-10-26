import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { TabPanel } from "./TabPanel";
import { Tabs, type TabItem } from "./Tabs";

const items: TabItem[] = [
  { value: "tyres", label: "Tyres", id: "t-tyres", panelId: "p-tyres", count: 12 },
  { value: "inspections", label: "Inspections", id: "t-insp", panelId: "p-insp" },
  {
    value: "events",
    label: "Events",
    id: "t-events",
    panelId: "p-events",
    count: 3,
    critical: true,
  },
];

function Harness() {
  const [value, setValue] = useState("tyres");
  return (
    <>
      <Tabs label="Vehicle" items={items} value={value} onChange={setValue} data-testid="tabs" />
      {items.map((t) => (
        <TabPanel key={t.value} id={t.panelId} labelledBy={t.id} active={t.value === value}>
          <p>{t.label} content</p>
        </TabPanel>
      ))}
    </>
  );
}

describe("Tabs", () => {
  it("Tabs move with arrows and show only the active panel", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.getByRole("tablist", { name: "Vehicle" })).toHaveAttribute("data-testid", "tabs");

    const tyres = screen.getByRole("tab", { name: "Tyres 12" });
    expect(tyres).toHaveAttribute("aria-selected", "true");
    expect(tyres).toHaveAttribute("aria-controls", "p-tyres");
    expect(screen.getByRole("tabpanel", { name: "Tyres 12" })).toHaveTextContent("Tyres content");
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(screen.getByText("Inspections content")).not.toBeVisible();

    // One tab stop: the selected tab, then the panel.
    await user.tab();
    expect(tyres).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Inspections" })).toHaveAttribute("tabindex", "-1");

    await user.keyboard("{ArrowRight}");
    const inspections = screen.getByRole("tab", { name: "Inspections" });
    expect(inspections).toHaveFocus();
    expect(inspections).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel", { name: "Inspections" })).toBeVisible();
    expect(screen.getByText("Tyres content")).not.toBeVisible();

    await user.keyboard("{ArrowRight}{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Tyres 12" })).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "Events 3" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("tab", { name: "Tyres 12" })).toHaveFocus();
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: "Events 3" })).toHaveAttribute("aria-selected", "true");

    await user.tab();
    expect(screen.getByRole("tabpanel", { name: "Events 3" })).toHaveFocus();
  });

  it("selects a tab on click", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("tab", { name: "Events 3" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Events content");
  });
});
