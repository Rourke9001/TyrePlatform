import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Sheet } from "./Sheet";

function ModalHarness({ onClose }: { onClose: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open the sheet
      </button>
      <Sheet
        open={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Tyre T-104"
        footer={<button type="button">Save</button>}
        data-testid="sheet"
      >
        <button type="button">Fit a tyre</button>
      </Sheet>
    </>
  );
}

describe("Sheet", () => {
  it("Sheet modal traps focus, closes on Escape and returns focus", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ModalHarness onClose={onClose} />);
    const opener = screen.getByRole("button", { name: "Open the sheet" });
    await user.click(opener);

    const sheet = screen.getByRole("dialog", { name: "Tyre T-104" });
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(sheet).toHaveAttribute("data-testid", "sheet");
    expect(sheet).toHaveFocus();

    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Fit a tyre" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();
    // The last stop wraps to the first, and back again, never to the page.
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Save" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("names a modal sheet by ariaLabel over its visible title", () => {
    render(
      <Sheet open onClose={() => undefined} title="Spare tyre" ariaLabel="Spare, LINK6">
        <p>body</p>
      </Sheet>,
    );
    const sheet = screen.getByRole("dialog", { name: "Spare, LINK6" });
    expect(sheet).toHaveTextContent("Spare tyre");
  });

  it("closes a modal sheet from the scrim, not from a press inside the panel", () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Tyre T-104">
        <p>body</p>
      </Sheet>,
    );
    fireEvent.mouseDown(screen.getByText("body"));
    expect(onClose).not.toHaveBeenCalled();
    const scrim = screen.getByRole("dialog").parentElement;
    if (scrim === null) throw new Error("the sheet has no scrim");
    fireEvent.mouseDown(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders nothing while closed", () => {
    render(
      <Sheet open={false} onClose={() => undefined} title="Tyre T-104">
        <p>body</p>
      </Sheet>,
    );
    expect(screen.queryByText("body")).toBeNull();
  });

  it("Sheet with modal false is a region named by ariaLabel, not a dialog, and leaves focus where it is on open, on Escape and on close", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Position 3
          </button>
          <button type="button" onClick={() => setOpen(false)}>
            Next position
          </button>
          <Sheet
            modal={false}
            open={open}
            onClose={onClose}
            title="Spare tyre"
            ariaLabel="Spare, LINK6"
            data-position="S1"
          >
            <button type="button">1</button>
          </Sheet>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Position 3" });
    await user.click(opener);

    const sheet = screen.getByRole("region", { name: "Spare, LINK6" });
    expect(sheet.tagName).toBe("SECTION");
    expect(sheet).toHaveTextContent("Spare tyre");
    expect(sheet).not.toHaveAttribute("role");
    expect(sheet).not.toHaveAttribute("aria-modal");
    expect(sheet).toHaveAttribute("data-position", "S1");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Spare, LINK6" })).toBeInTheDocument();
    expect(opener).toHaveFocus();

    const next = screen.getByRole("button", { name: "Next position" });
    await user.click(next);
    expect(screen.queryByRole("region", { name: "Spare, LINK6" })).toBeNull();
    expect(next).toHaveFocus();
  });

  it("offers a Close button only when given onClose", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <Sheet modal={false} open title="Position 3" ariaLabel="Position 3">
        <p>body</p>
      </Sheet>,
    );
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
    rerender(
      <Sheet modal={false} open title="Position 3" ariaLabel="Position 3" onClose={onClose}>
        <p>body</p>
      </Sheet>,
    );
    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // Today's spare sheet puts "No spare" after Close (capture/PositionSheet.tsx).
  it("puts its actions before Close and its trailing control after it", async () => {
    const user = userEvent.setup();
    render(
      <Sheet
        modal={false}
        open
        title="Spare tyre"
        ariaLabel="Spare, TRL-02"
        onClose={() => undefined}
        actions={<button type="button">Tread guide</button>}
        trailing={<button type="button">No spare</button>}
      >
        <p>body</p>
      </Sheet>,
    );
    await user.tab();
    expect(screen.getByRole("button", { name: "Tread guide" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "No spare" })).toHaveFocus();
  });

  it("names a non-modal sheet by its title when it has no ariaLabel", () => {
    render(
      <Sheet modal={false} open title="Position 3">
        <p>body</p>
      </Sheet>,
    );
    expect(screen.getByRole("region", { name: "Position 3" })).toBeInTheDocument();
  });

  it("can set its title as a paragraph, so a screen keeps the headings it has", () => {
    render(
      <Sheet modal={false} open title="Position 3" ariaLabel="Position 3" titleAs="p">
        <p>body</p>
      </Sheet>,
    );
    expect(screen.queryByRole("heading")).toBeNull();
    expect(screen.getByText("Position 3", { selector: "p" })).toBeInTheDocument();
  });
});
