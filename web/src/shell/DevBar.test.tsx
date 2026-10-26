import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

import { DevBar } from "./DevBar";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

// vitest runs with import.meta.env.DEV true, so the bar renders; the
// production case is the build, where the import.meta.env.DEV branch is
// dead code and eliminated.
describe("DevBar", () => {
  it("is collapsed by default with every switcher inside", () => {
    render(<DevBar />);
    const summary = screen.getByText(/^Dev:/);
    expect(summary.closest("details")).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Tenant (dev)")).not.toBeVisible();
    expect(screen.getByLabelText("Actor (dev)")).not.toBeVisible();
    expect(screen.getByLabelText("Appearance (dev)")).not.toBeVisible();
  });

  it("appearance select sets data-theme", async () => {
    render(<DevBar />);
    await userEvent.click(screen.getByText(/^Dev:/));
    const select = screen.getByLabelText("Appearance (dev)");
    expect(screen.getByRole("option", { name: "System" })).toBeInTheDocument();

    await userEvent.selectOptions(select, "Night shift");
    expect(document.documentElement).toHaveAttribute("data-theme", "dark");
    expect(select).toHaveValue("dark");

    await userEvent.selectOptions(select, "Daylight");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");
    expect(select).toHaveValue("light");
  });
});
