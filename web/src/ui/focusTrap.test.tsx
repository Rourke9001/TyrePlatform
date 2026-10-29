import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { useFocusTrap } from "./focusTrap";

function Trap({
  name,
  onEscape,
  children,
}: {
  name: string;
  onEscape: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, true, onEscape);
  return (
    <div ref={ref} role="dialog" aria-label={name} tabIndex={-1}>
      {children}
    </div>
  );
}

// The inner trap renders beside the outer one, not inside it, so only the
// stack of open traps tells them apart.
function Nested() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOuter(true)}>
        Page
      </button>
      {outer && (
        <Trap name="Outer" onEscape={() => setOuter(false)}>
          <button type="button" onClick={() => setInner(true)}>
            Open inner
          </button>
        </Trap>
      )}
      {inner && (
        <Trap name="Inner" onEscape={() => setInner(false)}>
          <button type="button">Inner action</button>
        </Trap>
      )}
    </>
  );
}

describe("useFocusTrap", () => {
  it("lets only the innermost trap take Tab and Escape, and hands focus back in order", async () => {
    const user = userEvent.setup();
    render(<Nested />);
    expect(screen.getByRole("dialog", { name: "Outer" })).toHaveFocus();

    const openInner = screen.getByRole("button", { name: "Open inner" });
    await user.click(openInner);
    expect(screen.getByRole("dialog", { name: "Inner" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Inner action" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Inner action" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeInTheDocument();
    expect(openInner).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Outer" })).toBeNull();
  });

  it("holds focus on the panel when nothing inside it can take focus", async () => {
    const user = userEvent.setup();
    render(
      <Trap name="Empty" onEscape={() => undefined}>
        <p>Nothing to press</p>
      </Trap>,
    );
    const panel = screen.getByRole("dialog", { name: "Empty" });
    await user.tab();
    expect(panel).toHaveFocus();
    await user.tab({ shift: true });
    expect(panel).toHaveFocus();
  });

  // A control the trap lists can still refuse focus: one in a disabled
  // fieldset, a closed details, or a display: none box. Tab moves past it.
  it("passes over a stop that refuses focus, both ways", async () => {
    const user = userEvent.setup();
    render(
      <Trap name="Pending" onEscape={() => undefined}>
        <button type="button">Before</button>
        <fieldset disabled>
          <input aria-label="Amount" />
        </fieldset>
        <button type="button">Save</button>
      </Trap>,
    );
    const before = screen.getByRole("button", { name: "Before" });
    const save = screen.getByRole("button", { name: "Save" });
    before.focus();
    await user.tab();
    expect(save).toHaveFocus();
    await user.tab({ shift: true });
    expect(before).toHaveFocus();
  });

  // TYRE-275 item 1: a diagram's position can be an SVG control.
  it("returns focus to an SVG opener", async () => {
    const user = userEvent.setup();
    function Diagram() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <svg>
            <g
              role="button"
              tabIndex={0}
              aria-label="Position 3"
              onKeyDown={(e) => {
                if (e.key === "Enter") setOpen(true);
              }}
            />
          </svg>
          {open && (
            <Trap name="Position 3" onEscape={() => setOpen(false)}>
              <button type="button">Fit a tyre</button>
            </Trap>
          )}
        </>
      );
    }
    render(<Diagram />);
    const opener = screen.getByRole("button", { name: "Position 3" });
    await user.tab();
    expect(opener).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("dialog", { name: "Position 3" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  // A caller may pass returnTo as an object built in render; the trap must
  // not reopen on every render, or a typed field loses focus each key.
  it("keeps focus in a field when returnTo is a new object on every render", async () => {
    const user = userEvent.setup();
    function Typing() {
      const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
      const [value, setValue] = useState("");
      const ref = useRef<HTMLDivElement>(null);
      useFocusTrap(ref, true, () => undefined, { current: opener });
      return (
        <>
          <button type="button" ref={setOpener}>
            Opener
          </button>
          <div ref={ref} role="dialog" aria-label="Typing" tabIndex={-1}>
            <input aria-label="Note" value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
        </>
      );
    }
    render(<Typing />);
    const note = screen.getByRole("textbox", { name: "Note" });
    await user.click(note);
    await user.keyboard("12");
    expect(note).toHaveValue("12");
    expect(note).toHaveFocus();
  });
});
