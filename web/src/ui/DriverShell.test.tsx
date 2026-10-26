import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DriverShell } from "./DriverShell";

// Every stop Tab reaches, in order, from the top of the page until it cycles.
async function tabStops(user: ReturnType<typeof userEvent.setup>): Promise<string[]> {
  const stops: string[] = [];
  for (let i = 0; i < 20; i++) {
    await user.tab();
    const at = document.activeElement;
    if (at === null || at === document.body) break;
    stops.push(at.textContent ?? "");
  }
  return stops;
}

describe("DriverShell", () => {
  it("DriverShell renders its slots and the footer last", async () => {
    const user = userEvent.setup();
    render(
      <DriverShell
        brand={<span>Sandbox Fleet</span>}
        actor="Sandbox Driver · DRIVER"
        signOut={<button type="button">Sign out</button>}
        status={<p role="status">1 inspection waiting to send</p>}
        signIn={<p>Sign in to send 1 inspection</p>}
        devBar={
          <details>
            <summary>Dev: tenant and actor</summary>
          </details>
        }
        title="My inspections"
        footer={<button type="button">Start inspection</button>}
        data-route="today"
      >
        <a href="/capture/v1">PC-T1, due 27 Oct</a>
      </DriverShell>,
    );

    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Sandbox Fleet")).toBeInTheDocument();
    const actor = within(banner).getByText("Sandbox Driver · DRIVER");
    expect(actor.childNodes).toHaveLength(1);
    expect(within(banner).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 inspection waiting to send");
    expect(screen.getByText("Sign in to send 1 inspection")).toBeInTheDocument();

    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "My inspections" })).toBeVisible();
    expect(within(main).getByRole("link", { name: "PC-T1, due 27 Oct" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(banner.parentElement).toHaveAttribute("data-route", "today");

    expect(await tabStops(user)).toEqual([
      "Sign out",
      "PC-T1, due 27 Oct",
      "Dev: tenant and actor",
      "Start inspection",
    ]);
  });

  it("puts a back button where the brand sits when given onBack", async () => {
    const user = userEvent.setup();
    const onBack = vi.fn();
    render(
      <DriverShell
        brand={<span>Sandbox Fleet</span>}
        onBack={onBack}
        backLabel="Back to the rig"
        barTitle="TRK-01"
      >
        <p>body</p>
      </DriverShell>,
    );
    const banner = screen.getByRole("banner");
    expect(within(banner).queryByText("Sandbox Fleet")).toBeNull();
    expect(within(banner).getByText("TRK-01")).toBeInTheDocument();
    await user.click(within(banner).getByRole("button", { name: "Back to the rig" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
