import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppShell } from "./AppShell";
import { ActorContext } from "../auth/actorContext";
import { me } from "../test/fixtures";
import { deriveBrandTheme } from "../theme/derive";
import { ThemeContext } from "../theme/themeContext";

const branding = { displayName: "Sandbox Fleet", primaryColor: "#E2202A", logoUrl: null };

// The nav is the only thing under test, but AppShell mounts OutboxIndicator,
// which flushes the queue on mount (FR-OFF-009) and would otherwise reach the
// network. That is the same stub that OutboxIndicator's own suite uses.
function renderShellAt(path: string, capabilities: string[]) {
  return render(
    <ThemeContext value={{ branding, theme: deriveBrandTheme(branding.primaryColor) }}>
      <ActorContext
        value={{ actor: me({ displayName: "Controller", capabilities }), settled: true }}
      >
        <MemoryRouter initialEntries={[path]}>
          <AppShell>
            <p>screen</p>
          </AppShell>
        </MemoryRouter>
      </ActorContext>
    </ThemeContext>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the shell's main nav", () => {
  // NAV_ITEMS nest, so NavLink's prefix match marks every ancestor current
  // too; the deepest path an actor with all capabilities can reach is what
  // over-claims if the guard is missing (NFR-USE-005).
  it("marks exactly one link current on the deepest nested path", () => {
    renderShellAt("/fleet/tyres/retreads", ["ViewFleet", "ManageAssets", "LogRetread"]);

    const current = screen.getAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("Retreads");
    // The over-claiming links are present and simply not current: without
    // this, a nav that dropped them entirely would satisfy the count above.
    expect(screen.getByRole("link", { name: "Units" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tyres" })).toBeInTheDocument();
  });

  // TYRE-242: the switchers must not sit in the header a driver sees first.
  it("keeps the dev switchers out of the header", () => {
    renderShellAt("/my", ["CaptureInspection"]);
    const header = screen.getByRole("banner");
    expect(header.querySelector("select")).toBeNull();
    expect(screen.getByText(/^Dev:/)).toBeInTheDocument();
  });
});
