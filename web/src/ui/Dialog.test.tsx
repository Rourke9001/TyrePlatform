import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "./Dialog";

describe("Dialog", () => {
  it("is a named dialog that closes on Escape", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Dialog
        open
        onOpenChange={onOpenChange}
        title="Dispose tyre"
        description="This cannot be undone."
      >
        <p>body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Dispose tyre" });
    expect(dialog).toHaveAccessibleDescription("This cannot be undone.");
    expect(dialog).toContainElement(screen.getByText("body"));
    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("has no accessible description when given none", () => {
    render(
      <Dialog open onOpenChange={() => undefined} title="Dispose tyre">
        <p>body</p>
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Dispose tyre" });
    expect(dialog).not.toHaveAttribute("aria-describedby");
    expect(dialog).toHaveAccessibleDescription("");
  });

  it("returns focus to the control that opened it", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Dispose
          </button>
          <Dialog open={open} onOpenChange={setOpen} title="Dispose tyre">
            <p>body</p>
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Dispose" });
    await user.click(opener);
    expect(screen.getByRole("dialog", { name: "Dispose tyre" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
