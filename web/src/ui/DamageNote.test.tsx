import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { DamageNote } from "./DamageNote";
import chipsCss from "./ChoiceChips.css?raw";
import css from "./DamageNote.css?raw";
import inputCss from "./TextInput.css?raw";

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

  // WAI-ARIA radio group: one tab stop, and the arrows move the choice.
  it("is one tab stop whose arrows move the choice", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [type, setType] = useState<string | null>("CUT");
      return (
        <DamageNote
          types={types}
          type={type}
          onTypeChange={setType}
          note=""
          onNoteChange={vi.fn()}
        />
      );
    }
    render(<Harness />);
    await user.tab();
    expect(screen.getByRole("radio", { name: "Cut" })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    const bulge = screen.getByRole("radio", { name: "Bulge" });
    expect(bulge).toHaveFocus();
    expect(bulge).toHaveAttribute("aria-checked", "true");
    await user.tab();
    expect(screen.getByRole("textbox", { name: "Note (optional)" })).toHaveFocus();
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
  // glove size and none drops to the 44px floor. The chips and the note are
  // ChoiceChips and TextArea at their glove size; jsdom applies no CSS, so
  // this reads the sheets that size them.
  it("sizes every control for gloves", () => {
    render(
      <DamageNote
        types={types}
        type={null}
        onTypeChange={vi.fn()}
        note=""
        onNoteChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("radiogroup", { name: "Damage type" })).toHaveClass("tr-chips--glove");
    expect(screen.getByRole("textbox", { name: "Note (optional)" }).parentElement).toHaveClass(
      "tr-input--glove",
    );
    const rule = (sheet: string, selector: string) => {
      const bare = sheet.replace(/\/\*[\s\S]*?\*\//g, "");
      const at = bare.indexOf(`${selector} {`);
      expect(at, selector).toBeGreaterThan(-1);
      return bare.slice(at, bare.indexOf("}", at));
    };
    expect(rule(chipsCss, ".tr-chips--glove .tr-chip")).toContain(
      "min-height: var(--target-glove)",
    );
    expect(rule(inputCss, ".tr-input--glove")).toContain("min-height: var(--target-glove)");
    expect(css).not.toContain("--target-min");
  });
});
