import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ConfigFailure } from "./ConfigFailure";

describe("ConfigFailure", () => {
  it("says what failed and what to do", () => {
    render(<ConfigFailure onRetry={() => undefined} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The app could not load its settings.");
    expect(alert).toHaveTextContent("Check your signal, then try again.");
    expect(alert).toHaveTextContent("Inspections already on this phone are kept.");
  });

  it("retries once per press", async () => {
    const onRetry = vi.fn();
    render(<ConfigFailure onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // NFR-USE-004; ConfigFailure.tsx says why it sets them.
  it("sets the design system's variables itself", () => {
    document.documentElement.style.removeProperty("--target-min");
    render(<ConfigFailure onRetry={() => undefined} />);
    expect(document.documentElement.style.getPropertyValue("--target-min")).not.toBe("");
  });
});
