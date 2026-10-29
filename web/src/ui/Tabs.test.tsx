import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { TabPanel } from "./TabPanel";
import panelCss from "./TabPanel.css?raw";
import { Tabs, type TabItem } from "./Tabs";
import tabsCss from "./Tabs.css?raw";

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

  // As SegmentedControl's test of the same name: Alt+Left is the browser's
  // back, and Ctrl, Cmd and Shift keys belong to the browser and the screen
  // reader.
  it("leaves an arrow, Home or End with a modifier to the browser", () => {
    const onChange = vi.fn();
    render(<Tabs label="Vehicle" items={items} value="inspections" onChange={onChange} />);
    const inspections = screen.getByRole("tab", { name: "Inspections" });
    inspections.focus();
    for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey"]) {
      for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
        expect(fireEvent.keyDown(inspections, { key, [modifier]: true })).toBe(true);
      }
    }
    expect(onChange).not.toHaveBeenCalled();
    expect(inspections).toHaveFocus();
    expect(fireEvent.keyDown(inspections, { key: "ArrowLeft" })).toBe(false);
    expect(onChange).toHaveBeenCalledWith("tyres");
  });

  it("runs a caller's onKeyDown as well as its own, and yields when the caller prevents it", () => {
    const onChange = vi.fn();
    const onKeyDown = vi.fn();
    const { rerender } = render(
      <Tabs
        label="Vehicle"
        items={items}
        value="tyres"
        onChange={onChange}
        onKeyDown={onKeyDown}
      />,
    );
    const tyres = screen.getByRole("tab", { name: "Tyres 12" });
    fireEvent.keyDown(tyres, { key: "ArrowRight" });
    expect(onKeyDown).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("inspections");

    rerender(
      <Tabs
        label="Vehicle"
        items={items}
        value="tyres"
        onChange={onChange}
        onKeyDown={(e) => e.preventDefault()}
      />,
    );
    fireEvent.keyDown(tyres, { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  // A value no tab holds (a filtered-out tab, a stale URL) still leaves one
  // tab stop, the first, as ChoiceChips does.
  it("keeps the first tab as the tab stop when the value matches none", async () => {
    const user = userEvent.setup();
    render(<Tabs label="Vehicle" items={items} value="gone" onChange={vi.fn()} />);
    await user.tab();
    expect(screen.getByRole("tab", { name: "Tyres 12" })).toHaveFocus();
  });

  // jsdom applies no CSS. A class that sets display, such as tr-stack,
  // outranks the browser's [hidden] rule, so the panel restates it; and the
  // list scrolls, which clips an outline drawn outside a tab.
  it("keeps an inactive panel hidden and a focused tab's ring inside the list", () => {
    const bare = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(bare(panelCss)).toMatch(/\.tr-tabpanel\[hidden\] \{[^}]*display: none;/);
    expect(bare(tabsCss)).toMatch(/\.tr-tab:focus-visible \{[^}]*outline-offset: -3px;/);
  });

  it("selects a tab on click", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("tab", { name: "Events 3" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Events content");
  });
});
