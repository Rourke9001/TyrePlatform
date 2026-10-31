import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { stubResize } from "../test/resize";
import { DriverShell } from "./DriverShell";
import driverCss from "./DriverShell.css?raw";

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

  // U159: the driver's links sit under the bar, after sign-out and ahead of
  // the outbox, each a glove target.
  it("puts the nav under the bar, ahead of the outbox", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <MemoryRouter>
        <DriverShell
          signOut={<button type="button">Sign out</button>}
          nav={[{ to: "/my", label: "My inspections" }]}
          status={<button type="button">Retry</button>}
        >
          <p>body</p>
        </DriverShell>
      </MemoryRouter>,
    );
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "My inspections" })).toHaveAttribute(
      "href",
      "/my",
    );
    expect(within(screen.getByRole("banner")).queryByRole("link")).toBeNull();
    expect(await tabStops(user)).toEqual(["Sign out", "My inspections", "Retry"]);
    expect(driverCss.replace(/\/\*[\s\S]*?\*\//g, "")).toMatch(
      /\.tr-driver__nav-link \{[^}]*min-height: var\(--target-glove\);/,
    );

    rerender(
      <MemoryRouter>
        <DriverShell nav={[]}>
          <p>body</p>
        </DriverShell>
      </MemoryRouter>,
    );
    expect(screen.queryByRole("navigation")).toBeNull();
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
  // As AppShell's test of the same name: the bar carries the brand.
  it("haloes the focus ring on the bar, which carries the brand", () => {
    expect(driverCss.replace(/\/\*[\s\S]*?\*\//g, "")).toMatch(
      /\.tr-driver__bar :focus-visible \{[^}]*box-shadow: 0 0 0 2px var\(--surface\);/,
    );
  });

  // WCAG 2.4.11: the footer sticks to the bottom at the caller's height, so
  // the page's scroll padding follows it.
  it("pads the page's scroll by the footer's height while it is shown", () => {
    const layout = stubResize(96);
    const html = document.documentElement;
    try {
      const { unmount } = render(
        <DriverShell footer={<button type="button">Submit</button>}>Body</DriverShell>,
      );
      act(() => layout.resize());
      expect(html.style.getPropertyValue("scroll-padding-bottom")).toBe(
        "calc(96px + var(--space-2))",
      );
      unmount();
      expect(html.style.getPropertyValue("scroll-padding-bottom")).toBe("");
    } finally {
      layout.restore();
    }
  });

  // The back button and its padding make the bar taller than the --appbar
  // figure base.css pads by.
  it("pads the page's scroll by the bar's height", () => {
    const layout = stubResize(64);
    const html = document.documentElement;
    try {
      const { unmount } = render(
        <DriverShell onBack={() => undefined} barTitle="LINK-A">
          Body
        </DriverShell>,
      );
      act(() => layout.resize());
      expect(html.style.getPropertyValue("scroll-padding-top")).toBe("calc(64px + var(--space-2))");
      unmount();
      expect(html.style.getPropertyValue("scroll-padding-top")).toBe("");
    } finally {
      layout.restore();
    }
  });
});
