import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { AppShell, type NavGroup } from "./AppShell";
import shellCss from "./AppShell.css?raw";

// Nested paths, so a link that matched by prefix would claim the deepest
// page for its ancestors too.
const nav: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", to: "/" },
      { label: "Exceptions", to: "/exceptions" },
    ],
  },
  {
    label: "Fleet",
    items: [
      { label: "Units", to: "/fleet" },
      { label: "Tyres", to: "/fleet/tyres" },
      { label: "Retreads", to: "/fleet/tyres/retreads" },
    ],
  },
];

function renderShell(path = "/fleet/tyres/retreads", groups: NavGroup[] = nav) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell
        nav={groups}
        brand={<span>Sandbox Fleet</span>}
        actor="Production Check · CONTROLLER"
        signOut={<button type="button">Sign out</button>}
        status={<p role="status">Nothing waiting to send</p>}
        signIn={<p>Signed in</p>}
        devBar={
          <details>
            <summary>Dev: tenant and actor</summary>
            <select aria-label="Tenant" />
          </details>
        }
        data-shell="manager"
      >
        <h1>Retreads</h1>
      </AppShell>
    </MemoryRouter>,
  );
}

describe("AppShell", () => {
  it("AppShell has a banner, a Main nav and the actor line as one text", () => {
    renderShell();
    const banner = screen.getByRole("banner");
    expect(within(banner).getByText("Sandbox Fleet")).toBeInTheDocument();
    const actor = within(banner).getByText("Production Check · CONTROLLER");
    expect(actor.childNodes).toHaveLength(1);
    expect(within(banner).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    // TYRE-242: the dev switchers never sit in the header.
    expect(banner.querySelector("select")).toBeNull();

    const main = screen.getByRole("main");
    expect(within(main).getByRole("heading", { level: 1, name: "Retreads" })).toBeInTheDocument();
    const devBar = screen.getByText("Dev: tenant and actor");
    expect(main.compareDocumentPosition(devBar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(banner.compareDocumentPosition(screen.getByRole("status"))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(banner.parentElement).toHaveAttribute("data-shell", "manager");

    const mainNav = screen.getByRole("navigation", { name: "Main" });
    expect(within(mainNav).getByRole("list", { name: "Fleet" })).toBeInTheDocument();
    expect(within(mainNav).getAllByRole("link")).toHaveLength(5);
  });

  it("marks exactly one link current on the deepest nested path", () => {
    renderShell();
    const current = screen.getAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Retreads");
    expect(screen.getByRole("link", { name: "Tyres" })).toHaveAttribute("href", "/fleet/tyres");
  });

  it("opens and closes the drawer from the menu button, Escape and a nav link", async () => {
    const user = userEvent.setup();
    renderShell("/");
    const menu = screen.getByRole("button", { name: "Menu" });
    const drawer = document.getElementById(menu.getAttribute("aria-controls") ?? "");
    expect(drawer).toContainElement(screen.getByRole("navigation", { name: "Main" }));
    expect(menu).toHaveAttribute("aria-expanded", "false");

    await user.click(menu);
    expect(menu).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{Escape}");
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(menu).toHaveFocus();

    await user.click(menu);
    await user.click(screen.getByRole("link", { name: "Units" }));
    expect(menu).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("link", { name: "Units", current: "page" })).toBeInTheDocument();
  });

  // jsdom applies no stylesheet, so the drawer's closed state is read from
  // the source: visibility, not a transform alone, is what takes its links
  // out of the tab order below the drawer width.
  it("hides the closed drawer with visibility below 1024px", () => {
    const narrow = /@media \(max-width: 1023px\) \{([\s\S]*?)\n\}/.exec(shellCss)?.[1] ?? "";
    expect(narrow).toMatch(/\.tr-shell__side \{[^}]*visibility: hidden;/);
    expect(narrow).toMatch(
      /\.tr-shell\[data-open="true"\] \.tr-shell__side \{[^}]*visibility: visible;/,
    );
  });

  it("renders no nav and no menu button when the actor may open no page", () => {
    renderShell("/", [{ items: [] }]);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    expect(screen.getByRole("banner")).toBeInTheDocument();
  });
});
