import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Keypad, type KeypadKey } from "./Keypad";

const DIGITS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];

describe("Keypad", () => {
  it("Keypad shows Delete by default and the half key with altKey half", () => {
    const { unmount } = render(<Keypad onKey={vi.fn()} goLabel="Next ›" />);
    expect(screen.getByRole("button", { name: "Delete" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "½" })).toBeNull();
    unmount();

    render(<Keypad onKey={vi.fn()} goLabel="Next ›" altKey="half" />);
    expect(screen.getByRole("button", { name: "½" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
  });

  it("the half key emits half", async () => {
    const user = userEvent.setup();
    const onKey = vi.fn<(key: KeypadKey) => void>();
    render(<Keypad onKey={onKey} goLabel="Next ›" altKey="half" />);
    await user.click(screen.getByRole("button", { name: "½" }));
    expect(onKey).toHaveBeenCalledExactlyOnceWith("half");
  });

  it("the delete key emits delete", async () => {
    const user = userEvent.setup();
    const onKey = vi.fn<(key: KeypadKey) => void>();
    render(<Keypad onKey={onKey} goLabel="Next ›" />);
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onKey).toHaveBeenCalledExactlyOnceWith("delete");
  });

  // U145: whole millimetres and the half key, never a decimal point under a
  // glove.
  it("Keypad has no decimal key", () => {
    render(<Keypad onKey={vi.fn()} goLabel="Next ›" altKey="half" />);
    const names = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).not.toContain(".");
    expect(names).not.toContain(",");
    expect(screen.queryByRole("button", { name: /decimal|point/i })).toBeNull();
  });

  it("the go key is named exactly goLabel", async () => {
    const user = userEvent.setup();
    const onKey = vi.fn<(key: KeypadKey) => void>();
    const { rerender } = render(<Keypad onKey={onKey} goLabel="Next ›" />);
    const go = screen.getByRole("button", { name: "Next ›" });
    expect(go).toHaveAccessibleName("Next ›");
    await user.click(go);
    expect(onKey).toHaveBeenCalledExactlyOnceWith("go");

    rerender(<Keypad onKey={onKey} goLabel="Seen it ›" goTone="warn" />);
    expect(screen.getByRole("button", { name: "Seen it ›" })).toHaveAccessibleName("Seen it ›");
  });

  it("Keypad digits are named 0 to 9", async () => {
    const user = userEvent.setup();
    const onKey = vi.fn<(key: KeypadKey) => void>();
    render(<Keypad onKey={onKey} goLabel="Next ›" />);
    // A string name matches the whole name, as e2e's exact: true does.
    for (const d of DIGITS) {
      await user.click(screen.getByRole("button", { name: d }));
    }
    expect(onKey.mock.calls.map(([key]) => key)).toEqual(DIGITS);
  });

  // NFR-USE-004 and TYRE-220: four rows, so the go key stays on a 780px
  // screen; the alt key sits left of 0 and go to its right.
  it("lays the keys out as 1 to 9, then the alt key, 0 and go", () => {
    render(<Keypad onKey={vi.fn()} goLabel="Done ›" />);
    const order = screen
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(order).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "Delete", "0", "Done ›"]);
  });

  it("names the keypad as a group only when the caller gives a name", () => {
    const { unmount } = render(<Keypad onKey={vi.fn()} goLabel="Next ›" />);
    expect(screen.queryByRole("group")).toBeNull();
    unmount();

    render(<Keypad onKey={vi.fn()} goLabel="Next ›" ariaLabel="Number keypad" />);
    expect(screen.getByRole("group", { name: "Number keypad" })).toBeInTheDocument();
  });

  it("passes unknown props to its root and disables go on request", () => {
    const { container } = render(
      <Keypad onKey={vi.fn()} goLabel="Next ›" goDisabled data-testid="pad" />,
    );
    expect(container.firstElementChild).toHaveAttribute("data-testid", "pad");
    expect(screen.getByRole("button", { name: "Next ›" })).toBeDisabled();
  });
});
