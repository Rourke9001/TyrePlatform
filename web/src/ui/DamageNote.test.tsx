import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DamageNote } from "./DamageNote";
import css from "./DamageNote.css?raw";

// FR-INS-024: the types are tenant configuration, so the fixture's words are
// the test's own and the component brings none.
const types = [
  { value: "CUT", label: "Cut" },
  { value: "BULGE", label: "Bulge" },
  { value: "OTHER", label: "Something else" },
];

describe("DamageNote", () => {
  it("offers the caller's damage types as one choice", async () => {
    const user = userEvent.setup();
    const onTypeChange = vi.fn<(value: string) => void>();
    render(
      <DamageNote
        types={types}
        type="BULGE"
        onTypeChange={onTypeChange}
        note=""
        onNoteChange={vi.fn()}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Damage type" });
    const radios = Array.from(group.querySelectorAll('[role="radio"]'));
    expect(radios.map((r) => r.textContent)).toEqual(["Cut", "Bulge", "Something else"]);
    expect(screen.getByRole("radio", { name: "Bulge" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Cut" })).toHaveAttribute("aria-checked", "false");
    await user.click(screen.getByRole("radio", { name: "Something else" }));
    expect(onTypeChange).toHaveBeenCalledExactlyOnceWith("OTHER");
  });

  it("brings no damage type of its own", () => {
    render(
      <DamageNote types={[]} type={null} onTypeChange={vi.fn()} note="" onNoteChange={vi.fn()} />,
    );
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("labels the note and hands back what is typed", async () => {
    const user = userEvent.setup();
    const onNoteChange = vi.fn<(value: string) => void>();
    render(
      <DamageNote
        types={types}
        type={null}
        onTypeChange={vi.fn()}
        note="Sidewall"
        onNoteChange={onNoteChange}
      />,
    );
    const note = screen.getByRole("textbox", { name: "Note (optional)" });
    expect(note).toHaveValue("Sidewall");
    await user.type(note, "!");
    expect(onNoteChange).toHaveBeenLastCalledWith("Sidewall!");
  });

  it("passes unknown props to its root", () => {
    const { container } = render(
      <DamageNote
        types={types}
        type={null}
        onTypeChange={vi.fn()}
        note=""
        onNoteChange={vi.fn()}
        data-testid="damage"
      />,
    );
    expect(container.firstElementChild).toHaveAttribute("data-testid", "damage");
  });

  // TYRE-152, TYRE-448: a driver control by design, so every target is the
  // glove size and none drops to the 44px floor. jsdom applies no CSS, so
  // this reads the stylesheet.
  it("sizes every control for gloves", () => {
    const sheet = css.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(sheet).not.toContain("--target-min");
    for (const selector of [".tr-damage__chip", ".tr-damage__input"]) {
      const at = sheet.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      expect(sheet.slice(at, sheet.indexOf("}", at))).toContain("min-height: var(--target-glove)");
    }
  });
});
