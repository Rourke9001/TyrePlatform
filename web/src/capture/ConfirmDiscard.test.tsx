import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { expectNothingForbiddenSpoken } from "../test/spoken";
import { ConfirmDiscard } from "./ConfirmDiscard";

const props = {
  trigger: "Discard this inspection",
  question: "Discard the inspection of BAC039SP?",
  consequence: "3 captured positions will be lost.",
  confirm: "Discard",
};

describe("ConfirmDiscard", () => {
  // ADR-0009: a discard is explicit, confirmed and NAMED — which vehicle and
  // how many positions. Two taps on the recovery path, none on the clean one:
  // the trigger is the only thing rendered until it is pressed.
  it("shows nothing but the trigger until it is pressed", () => {
    render(<ConfirmDiscard {...props} onConfirm={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Discard this inspection" })).toBeInTheDocument();
    expect(screen.queryByText(/will be lost/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
  });

  it("names the vehicle and the cost, and only then lets the driver confirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { container } = render(<ConfirmDiscard {...props} onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Discard this inspection" }));
    const panel = screen.getByRole("group", { name: "Discard the inspection of BAC039SP?" });
    expect(panel).toHaveTextContent("3 captured positions will be lost.");
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expectNothingForbiddenSpoken(container, /discard/i);
  });

  // "Keep it" is the safe default and must be the way back, not a reload.
  it("closes without discarding when the driver keeps it", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ConfirmDiscard {...props} onConfirm={onConfirm} />);

    await user.click(screen.getByRole("button", { name: "Discard this inspection" }));
    await user.click(screen.getByRole("button", { name: "Keep it" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByText(/will be lost/)).toBeNull();
    expect(screen.getByRole("button", { name: "Discard this inspection" })).toBeInTheDocument();
  });
});
