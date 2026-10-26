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
});
