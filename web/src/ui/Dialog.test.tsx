import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Dialog } from "./Dialog";
import dialogCss from "./Dialog.css?raw";

describe("Dialog", () => {
  it("is a dialog named by its title and described by its description", () => {
    render(
      <Dialog
        open
        onClose={() => undefined}
        title="Keep the estimate as final?"
        description="No invoice can be recorded for this receipt afterwards."
        actions={<button type="button">Keep the estimate</button>}
        data-testid="confirm"
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Keep the estimate as final?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("data-testid", "confirm");
    expect(dialog).toHaveAccessibleDescription(
      "No invoice can be recorded for this receipt afterwards.",
    );
    expect(within(dialog).getByRole("button", { name: "Keep the estimate" })).toBeInTheDocument();
  });

  it("has no accessible description when given neither a description nor a body", () => {
    render(
      <Dialog
        open
        onClose={() => undefined}
        title="Dispose tyre"
        actions={<button type="button">Dispose</button>}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Dispose tyre" });
    expect(dialog).not.toHaveAttribute("aria-describedby");
    expect(dialog).toHaveAccessibleDescription("");
  });

  it("is described by its body when it has no description", () => {
    render(
      <Dialog
        open
        onClose={() => undefined}
        title="Dispose tyre"
        tone="danger"
        actions={<button type="button">Dispose</button>}
      >
        The tyre leaves the register.
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Dispose tyre" });
    expect(dialog).toHaveAccessibleDescription("The tyre leaves the register.");
  });

  // A caller's `{pending && <p>...</p>}` passes false; nothing renders, so
  // nothing may describe the dialog.
  it("draws no body and no description for children that render nothing", () => {
    const pending = false;
    render(
      <Dialog
        open
        onClose={() => undefined}
        title="Dispose tyre"
        description={null}
        actions={<button type="button">Dispose</button>}
      >
        {pending && <p>Saving</p>}
        {null}
      </Dialog>,
    );
    const dialog = screen.getByRole("dialog", { name: "Dispose tyre" });
    expect(dialog).not.toHaveAttribute("aria-describedby");
    expect(dialog.querySelector(".tr-dialog__body, .tr-dialog__desc")).toBeNull();
  });

  // jsdom lays nothing out, so the panel's fit is read from the source: it
  // never grows past the viewport, and its body scrolls inside it.
  it("keeps the panel inside the viewport and scrolls its body", () => {
    expect(dialogCss).toMatch(/\.tr-dialog \{[^}]*max-height: 100%;/);
    expect(dialogCss).toMatch(/\.tr-dialog__body \{[^}]*overflow-y: auto;/);
  });

  it("traps focus, closes on Escape and returns focus to the control that opened it", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Dispose
          </button>
          <Dialog
            open={open}
            onClose={() => {
              onClose();
              setOpen(false);
            }}
            title="Dispose tyre"
            actions={
              <>
                <button type="button">Keep it</button>
                <button type="button">Dispose it</button>
              </>
            }
          />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Dispose" });
    await user.click(opener);
    expect(screen.getByRole("dialog", { name: "Dispose tyre" })).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Dispose it" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  // A confirmation is answered by one of its actions; a stray press outside
  // it is not an answer.
  it("stays open when the scrim is pressed", () => {
    const onClose = vi.fn();
    render(
      <Dialog
        open
        onClose={onClose}
        title="Dispose tyre"
        actions={<button type="button">Dispose</button>}
      />,
    );
    const scrim = screen.getByRole("dialog").parentElement;
    if (scrim === null) throw new Error("the dialog has no scrim");
    fireEvent.mouseDown(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("a backdrop click closes when dismissOnBackdrop is set", async () => {
    const user = userEvent.setup();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Dispose
          </button>
          <Dialog
            open={open}
            onClose={() => setOpen(false)}
            dismissOnBackdrop
            title="Dispose tyre"
            actions={<button type="button">Keep it</button>}
          />
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Dispose" });
    await user.click(opener);
    const scrim = screen.getByRole("dialog").parentElement;
    if (scrim === null) throw new Error("the dialog has no scrim");
    await user.click(screen.getByRole("heading", { name: "Dispose tyre" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.click(scrim);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("a backdrop click does nothing by default", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Dialog
        open
        onClose={onClose}
        title="Dispose tyre"
        actions={<button type="button">Dispose</button>}
      />,
    );
    const scrim = screen.getByRole("dialog").parentElement;
    if (scrim === null) throw new Error("the dialog has no scrim");
    await user.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });

  // A drag that starts or ends in the panel is targeted at the scrim, their
  // common ancestor, so the click alone cannot tell it from a scrim click.
  it.each([
    ["press on the scrim, release on the panel", "scrim", "panel"],
    ["press on the panel, release on the scrim", "panel", "scrim"],
  ])("a drag does not close: %s", (_name, from, to) => {
    const onClose = vi.fn();
    render(
      <Dialog
        open
        onClose={onClose}
        dismissOnBackdrop
        title="Dispose tyre"
        actions={<button type="button">Dispose</button>}
      />,
    );
    const panel = screen.getByRole("dialog");
    const scrim = panel.parentElement;
    if (scrim === null) throw new Error("the dialog has no scrim");
    const el = (which: string) => (which === "scrim" ? scrim : panel);
    fireEvent.mouseDown(el(from));
    fireEvent.mouseUp(el(to));
    fireEvent.click(scrim);
    expect(onClose).not.toHaveBeenCalled();
  });
});
