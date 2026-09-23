import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { DevBar } from "./DevBar";

// vitest runs with import.meta.env.DEV true, so the bar renders; the
// production case is the build, where the import.meta.env.DEV branch is
// dead code and eliminated.
describe("DevBar", () => {
  it("is collapsed by default with both switchers inside", () => {
    render(<DevBar />);
    const summary = screen.getByText(/^Dev:/);
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Tenant (dev)")).not.toBeVisible();
    expect(screen.getByLabelText("Actor (dev)")).not.toBeVisible();
  });
});
