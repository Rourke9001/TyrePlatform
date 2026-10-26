import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DamageNote } from "./DamageNote";

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

  it("sizes for gloves by default and passes unknown props to its root", () => {
    const { container, rerender } = render(
      <DamageNote
        types={types}
        type={null}
        onTypeChange={vi.fn()}
        note=""
        onNoteChange={vi.fn()}
        data-testid="damage"
      />,
    );
    const root = container.firstElementChild;
    expect(root).toHaveAttribute("data-testid", "damage");
    expect(root).toHaveClass("tr-damage--glove");

    rerender(
      <DamageNote
        types={types}
        type={null}
        onTypeChange={vi.fn()}
        note=""
        onNoteChange={vi.fn()}
        size="md"
      />,
    );
    expect(container.firstElementChild).not.toHaveClass("tr-damage--glove");
  });
});
