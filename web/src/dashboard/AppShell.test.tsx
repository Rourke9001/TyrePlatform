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
// network — the same stub OutboxIndicator's own suite uses.
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
  // NAV_ITEMS' paths nest, so NavLink's default prefix match marks every
  // ancestor current too: /fleet/tyres/retreads would read as Units, Tyres and
  // Retreads all at once, and "you are here" naming three places tells a
  // reader nothing (NFR-USE-005). The deepest path in the registry is the case
  // that catches it — an actor holding all three capabilities so all three
  // links render and a prefix match has something to over-claim.
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
});
