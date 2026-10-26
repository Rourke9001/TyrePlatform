import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SyncStatus, type SyncState } from "./SyncStatus";

describe("SyncStatus", () => {
  it("says what the outbox holds in each state", () => {
    const cases: [SyncState, number, string][] = [
      ["sent", 1, "All sent"],
      ["saved", 1, "Saved on phone"],
      ["sending", 1, "Sending"],
      ["sending", 3, "Sending 3"],
      ["waiting", 2, "2 waiting for signal"],
      ["waiting", 1200, "1,200 waiting for signal"],
      ["failed", 1, "1 needs the office"],
      ["failed", 2, "2 need the office"],
    ];
    for (const [state, count, words] of cases) {
      const { unmount } = render(<SyncStatus state={state} count={count} />);
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(new RegExp(`^${words}$`));
      expect(status).toHaveClass("tr-sync", `tr-sync--${state}`);
      unmount();
    }
  });

  it("is a button when it opens something, and says the same words", async () => {
    const onClick = vi.fn();
    render(<SyncStatus state="waiting" count={2} onClick={onClick} />);
    const button = screen.getByRole("button", { name: "2 waiting for signal" });
    expect(button).toHaveAttribute("aria-live", "polite");
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("takes the caller's words, hides its glyph and passes unknown props on", () => {
    const { container } = render(
      <SyncStatus state="saved" label="Held on this phone" data-testid="sync" />,
    );
    expect(screen.getByTestId("sync")).toHaveTextContent(/^Held on this phone$/);
    expect(container.querySelector(".tr-sync__dot")).toHaveAttribute("aria-hidden", "true");
  });
});
