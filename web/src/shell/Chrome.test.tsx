import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Chrome } from "./Chrome";
import { ActorContext, type ActorState } from "../auth/actorContext";
import { SUBJECT_KEY } from "../api/token";
import { db } from "../capture/draft";
import type { OutboxEntry } from "../capture/outbox";
import type { SubmitPayload } from "../capture/payload";
import { me } from "../test/fixtures";
import { deriveBrandTheme } from "../theme/derive";
import { ThemeContext } from "../theme/themeContext";

const branding = { displayName: "Sandbox Fleet", primaryColor: "#E2202A", logoUrl: null };

// Chrome mounts OutboxIndicator in both frames, which flushes the queue on
// mount (FR-OFF-009) and would otherwise reach the network. That is the same
// stub that OutboxIndicator's own suite uses.
function renderShellAt(path: string, capabilities: string[]) {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ThemeContext value={{ branding, theme: deriveBrandTheme(branding.primaryColor) }}>
        <ActorContext
          value={{ actor: me({ displayName: "Controller", capabilities }), settled: true }}
        >
          <MemoryRouter initialEntries={[path]}>
            <Chrome>
              <p>screen</p>
            </Chrome>
          </MemoryRouter>
        </ActorContext>
      </ThemeContext>
    </QueryClientProvider>,
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

  it("offers the dashboard and the exceptions to a fleet viewer", () => {
    renderShellAt("/", ["ViewFleet"]);
    expect(screen.getByRole("link", { name: "Dashboard", current: "page" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Exceptions" })).toHaveAttribute("href", "/exceptions");
  });

  // TYRE-242: the switchers must not sit in the header a driver sees first.
  it("keeps the dev switchers out of the header", () => {
    renderShellAt("/my", ["CaptureInspection"]);
    const header = screen.getByRole("banner");
    expect(header.querySelector("select")).toBeNull();
    expect(screen.getByText(/^Dev:/)).toBeInTheDocument();
  });
});

const outbox = () => db.table<OutboxEntry, string>("outbox");

// nextAttemptAt in the future: the indicator flushes on mount, and a due
// entry would be sent and never counted (OutboxIndicator.test.tsx).
function queued(clientUuid: string): OutboxEntry {
  return {
    clientUuid,
    state: "queued",
    payload: { client_uuid: clientUuid, readings: [] } as unknown as SubmitPayload,
    queuedAt: Date.now(),
    attempts: 0,
    nextAttemptAt: Date.now() + 3_600_000,
    lastStatus: null,
    lastCode: null,
    lastError: null,
    fleetNumber: null,
    driverSubject: "oid-driver-1",
    legacy: false,
  };
}

// One client for the life of a test, so a rerender with a new actor reads
// as the same app with GET /api/me answered.
function shellTree(client: QueryClient, path: string, state: ActorState) {
  return (
    <QueryClientProvider client={client}>
      <ThemeContext value={{ branding, theme: deriveBrandTheme(branding.primaryColor) }}>
        <ActorContext value={state}>
          <MemoryRouter initialEntries={[path]}>
            <Chrome>
              <p>screen</p>
            </Chrome>
          </MemoryRouter>
        </ActorContext>
      </ThemeContext>
    </QueryClientProvider>
  );
}

const ADMIN = [
  "ViewFleet",
  "CaptureInspection",
  "ManageAssignments",
  "ManageAssets",
  "LogRetread",
  "ViewValuation",
  "ManageConfig",
  "ManageUsers",
];

const WAITING = "1 inspection waiting to send";

// The bearer path with a stored subject, so SignInLine mounts its live
// region and SignOutButton renders, as they do on a signed-in phone.
describe("the shell for each audience", () => {
  beforeEach(async () => {
    window.localStorage.setItem("tyre.dev.auth", "bearer");
    window.localStorage.setItem(SUBJECT_KEY, "oid-driver-1");
    await db.open();
    await outbox().clear();
    await outbox().put(queued("u-1"));
  });

  afterEach(async () => {
    window.localStorage.clear();
    await outbox().clear();
  });

  // The outbox renders before any actor does (ADR-0009), so a driver whose
  // GET /api/me is slow on depot signal still sees what is waiting.
  it("shows the outbox, sign-in line and dev bar before the actor settles", async () => {
    render(shellTree(new QueryClient(), "/", { actor: null, settled: false }));

    expect(await screen.findByText(WAITING)).toBeVisible();
    const banner = screen.getByRole("banner");
    // The sign-in line's region is mounted while empty, so a later lapse is
    // an update a screen reader announces (SignInLine).
    const regions = screen.getAllByRole("status").filter((s) => !banner.contains(s));
    expect(regions).toHaveLength(2);
    expect(regions[0]).toHaveTextContent(WAITING);
    expect(regions[1]).toBeEmptyDOMElement();
    expect(screen.getByText(/^Dev:/)).toBeInTheDocument();
    expect(within(banner).getByRole("button", { name: "Sign out" })).toBeInTheDocument();
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(within(screen.getByRole("main")).getByText("screen")).toBeInTheDocument();
  });

  it("switches to the manager shell once ViewFleet arrives", async () => {
    const client = new QueryClient();
    const { rerender } = render(shellTree(client, "/", { actor: null, settled: false }));
    await screen.findByText(WAITING);
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();

    const actor = me({ displayName: "Controller", capabilities: ["ViewFleet"] });
    rerender(shellTree(client, "/", { actor, settled: true }));

    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Dashboard" })).toBeInTheDocument();
    const line = within(screen.getByRole("banner")).getByText("Controller · CONTROLLER");
    expect(line.childNodes).toHaveLength(1);
    expect(await screen.findByText(WAITING)).toBeVisible();
    expect(within(screen.getByRole("main")).getByText("screen")).toBeInTheDocument();
  });

  // A DRIVER holds CaptureInspection, which NAV_ITEMS offers as "My
  // inspections", so a manager shell given to a driver would show a nav.
  it("driver actors get the driver shell", async () => {
    const client = new QueryClient();
    const { rerender } = render(shellTree(client, "/my", { actor: null, settled: false }));
    const waiting = await screen.findByText(WAITING);

    const actor = me({
      displayName: "Sandbox Driver",
      role: "DRIVER",
      capabilities: ["CaptureInspection"],
    });
    rerender(shellTree(client, "/my", { actor, settled: true }));

    const line = within(screen.getByRole("banner")).getByText("Sandbox Driver · DRIVER");
    expect(line.childNodes).toHaveLength(1);
    expect(screen.queryByRole("navigation")).toBeNull();
    expect(screen.queryByRole("button", { name: "Menu" })).toBeNull();
    // The frame before the actor settles is this shell, so the outbox and
    // the driver's page are not remounted when it does.
    expect(screen.getByText(WAITING)).toBe(waiting);
    expect(within(screen.getByRole("main")).getByText("screen")).toBeInTheDocument();
  });

  // U159: a driver's link to My inspections shows on every page but its own,
  // NotFound and capture included, and none before /api/me settles.
  it("gives a driver a link to My inspections from every other page", async () => {
    const client = new QueryClient();
    const driver = me({ role: "DRIVER", capabilities: ["CaptureInspection"] });
    const { rerender } = render(shellTree(client, "/capture/v1", { actor: null, settled: false }));
    await screen.findByText(WAITING);
    expect(screen.queryByRole("navigation")).toBeNull();

    rerender(shellTree(client, "/capture/v1", { actor: driver, settled: true }));
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    expect(within(nav).getByRole("link", { name: "My inspections" })).toHaveAttribute(
      "href",
      "/my",
    );

    for (const path of ["/no-such-page", "/MY/"]) {
      rerender(<></>);
      rerender(shellTree(client, path, { actor: driver, settled: true }));
      const links = screen.queryAllByRole("link", { name: "My inspections" });
      expect(links, path).toHaveLength(path === "/no-such-page" ? 1 : 0);
    }
  });

  it("ViewFleet actors get grouped navigation", () => {
    const { unmount } = render(
      shellTree(new QueryClient(), "/", { actor: me({ capabilities: ADMIN }), settled: true }),
    );
    const nav = screen.getByRole("navigation", { name: "Main" });
    const labels = (group: string) =>
      within(within(nav).getByRole("list", { name: group }))
        .getAllByRole("link")
        .map((link) => link.textContent);
    expect(labels("Overview")).toEqual(["Dashboard", "Exceptions"]);
    expect(labels("Fleet")).toEqual(["Units", "Tyres", "Receipts", "Rigs", "Fitments", "Retreads"]);
    expect(labels("Organisation")).toEqual(["Fleet settings", "Add a unit", "Add a user"]);
    // A capturing manager reaches their own work from the same menu.
    expect(within(nav).getByRole("link", { name: "My inspections" })).toHaveAttribute(
      "href",
      "/my",
    );
    expect(within(nav).getAllByRole("link")).toHaveLength(12);
    unmount();

    // ViewFleet alone: no capture, nothing to organise.
    render(
      shellTree(new QueryClient(), "/", {
        actor: me({ capabilities: ["ViewFleet"] }),
        settled: true,
      }),
    );
    const viewer = screen.getByRole("navigation", { name: "Main" });
    expect(within(viewer).queryByRole("link", { name: "My inspections" })).toBeNull();
    expect(within(viewer).queryByRole("list", { name: "Organisation" })).toBeNull();
    expect(within(viewer).getAllByRole("link")).toHaveLength(5);
  });
});
