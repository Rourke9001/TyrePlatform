import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { expectNothingForbiddenSpoken } from "../test/spoken";
import { TyreTile, type Condition } from "./TyreTile";

const CONDITIONS: Condition[] = ["ok", "near", "limit", "unread", "nospare"];

describe("TyreTile", () => {
  it("TyreTile takes an ariaLabel override and passes data-position-id", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn<() => void>();
    render(
      <TyreTile
        numberText="1"
        valueText="9mm"
        badgeText="OK"
        condition="ok"
        ariaLabel="Position 1, BAC039SP, OK"
        data-position-id="p1"
        onClick={onClick}
      />,
    );
    const tile = screen.getByRole("button", { name: "Position 1, BAC039SP, OK" });
    // The button itself, not a wrapper: e2e taps and measures [data-position-id].
    expect(tile).toHaveAttribute("data-position-id", "p1");
    await user.click(tile);
    expect(onClick).toHaveBeenCalledOnce();
  });

  // FR-CFG-021 and rule 5: every word is the caller's, so the component adds
  // no unit and no state word of its own, whatever the condition.
  it("TyreTile renders only the caller's numberText, valueText and badgeText", () => {
    for (const condition of CONDITIONS) {
      const { unmount } = render(
        <TyreTile
          numberText="7"
          valueText="13mm"
          badgeText="Check"
          condition={condition}
          ariaLabel="Position 7"
          onClick={vi.fn()}
        />,
      );
      expect(screen.getByRole("button", { name: "Position 7" }).textContent).toBe("713mmCheck");
      unmount();
    }
    const { container } = render(<TyreTile numberText="S" condition="unread" />);
    expect(container.textContent).toBe("S");
  });

  it("TyreTile without a condition is neutral", () => {
    render(<TyreTile numberText="3" valueText="12" ariaLabel="Position 3" onClick={vi.fn()} />);
    const tile = screen.getByRole("button", { name: "Position 3" });
    expect(tile).toHaveClass("tr-tile--neutral");
    for (const tone of ["ok", "warn", "critical", "unread"]) {
      expect(tile).not.toHaveClass(`tr-tile--${tone}`);
    }
    expect(tile.querySelector("svg")).toBeNull();
  });

  it("draws each condition's tone and glyph", () => {
    const tones: Record<Condition, string> = {
      ok: "ok",
      near: "warn",
      limit: "critical",
      unread: "unread",
      nospare: "neutral",
    };
    for (const condition of CONDITIONS) {
      const { unmount } = render(
        <TyreTile numberText="1" condition={condition} ariaLabel="tile" onClick={vi.fn()} />,
      );
      const tile = screen.getByRole("button", { name: "tile" });
      expect(tile).toHaveClass(`tr-tile--${tones[condition]}`);
      expect(tile.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
      unmount();
    }
  });

  it("without an ariaLabel, its words are its name", () => {
    render(<TyreTile numberText="4" badgeText="Not done" onClick={vi.fn()} />);
    expect(screen.getByRole("button")).toHaveTextContent("4Not done");
    expect(screen.getByRole("button")).not.toHaveAttribute("aria-label");
  });

  it("is a named image, not a button, when it cannot be tapped", () => {
    const { rerender } = render(
      <TyreTile numberText="2" valueText="11mm" ariaLabel="Position 2, 11mm" />,
    );
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img", { name: "Position 2, 11mm" })).toBeInTheDocument();

    rerender(<TyreTile numberText="2" empty ariaLabel="Position 2, no tyre" onClick={vi.fn()} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("img", { name: "Position 2, no tyre" })).toHaveClass("tr-tile--empty");
  });

  it("marks selection with aria-pressed and the open tile with data-active, and keeps the caller's class", () => {
    const { rerender } = render(
      <TyreTile numberText="1" ariaLabel="tile" onClick={vi.fn()} className="extra" />,
    );
    const tile = () => screen.getByRole("button", { name: "tile" });
    expect(tile()).not.toHaveAttribute("aria-pressed");
    expect(tile()).not.toHaveAttribute("data-active");
    expect(tile()).toHaveClass("tr-tile", "extra");

    rerender(<TyreTile numberText="1" ariaLabel="tile" onClick={vi.fn()} selected active />);
    expect(tile()).toHaveAttribute("aria-pressed", "true");
    expect(tile()).toHaveAttribute("data-active", "true");
  });

  it("speaks no compliance or side word of its own", () => {
    const { container } = render(
      <TyreTile numberText="1" valueText="9mm" badgeText="OK" condition="ok" onClick={vi.fn()} />,
    );
    expectNothingForbiddenSpoken(container, /9mm/);
  });
});
