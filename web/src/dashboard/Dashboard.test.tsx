import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardBody, renderWithActor, requestedUrl, respond } from "../test/fixtures";
import Dashboard from "./Dashboard";

function stubApi(body = dashboardBody()) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (url.startsWith("/api/dashboard")) return Promise.resolve(respond(200, body));
    if (url.startsWith("/api/spares")) {
      return Promise.resolve(
        respond(200, { scope: body.scope, judgedAt: "TENANT_TODAY", spares: [] }),
      );
    }
    if (url.startsWith("/api/depots")) {
      return Promise.resolve(respond(200, [{ id: "d1", name: "Johannesburg", type: "DEPOT" }]));
    }
    return Promise.resolve(respond(404, { code: "not_found", message: "no" }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function calls(prefix: string): string[] {
  return vi
    .mocked(fetch)
    .mock.calls.map((c) => requestedUrl(c[0]))
    .filter((u) => u.startsWith(prefix));
}

// A TECHNICIAN of two depots, one a DEPOT and one a STORE, plus a
// retreader row U85 keeps out of the filter even though it is theirs.
const technician = { role: "TECHNICIAN", depots: ["d1", "d2", "r1"], scope: "DEPOT" };

function stubDepotScopedApi() {
  const fetchMock = stubApi();
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (url === "/api/dashboard") {
      return Promise.resolve(
        respond(
          200,
          dashboardBody({
            scope: { level: "DEPOTS", depotCount: 2, depot: null },
            moneyVisible: false,
          }),
        ),
      );
    }
    if (url.startsWith("/api/dashboard?depot=")) {
      return Promise.resolve(
        respond(
          200,
          dashboardBody({
            scope: { level: "DEPOT", depotCount: 1, depot: "d1" },
            moneyVisible: false,
          }),
        ),
      );
    }
    if (url.startsWith("/api/depots")) {
      return Promise.resolve(
        respond(200, [
          { id: "d1", name: "Johannesburg", type: "DEPOT" },
          { id: "d2", name: "Durban", type: "STORE" },
          { id: "d3", name: "Cape Town", type: "DEPOT" },
          { id: "r1", name: "Retreaders", type: "RETREADER" },
        ]),
      );
    }
    return Promise.resolve(
      respond(200, {
        scope: { level: "DEPOTS", depotCount: 2, depot: null },
        judgedAt: "TENANT_TODAY",
        spares: [],
      }),
    );
  });
}

async function expectOwnDepotsOnly(user: ReturnType<typeof userEvent.setup>) {
  const picker = screen.getByRole("combobox", { name: "Depot" });
  picker.focus();
  await user.keyboard("{Enter}");
  expect(await screen.findAllByRole("option")).toHaveLength(3);
  expect(screen.getByRole("option", { name: "All my depots" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Johannesburg" })).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Durban" })).toBeInTheDocument();
}

beforeEach(() => {
  stubApi();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Dashboard", () => {
  // U17 and rule 6: one call, one as-at instant, in the tenant's zone and
  // named once, as the accepted mockup writes it.
  it("renders the hero and the as-at instant from one call", async () => {
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet", "ViewValuation"],
      withRouter: true,
    });
    expect(await screen.findByText("R16,537.50")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Dashboard" })).toBeInTheDocument();
    expect(
      screen.getByText(/^As at 22 Sept? 2026 09:10, Africa\/Johannesburg$/),
    ).toBeInTheDocument();
    expect(calls("/api/dashboard")).toHaveLength(1);
  });

  // FR-DSH-013 and U41: the button is the only refetch, and it refetches
  // the spares list (its own query, U51) with the dashboard.
  it("refetches only when Refresh is pressed, the spares with it", async () => {
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet", "ViewValuation"],
      withRouter: true,
    });
    await screen.findByText("R16,537.50");
    await waitFor(() => expect(calls("/api/spares")).toHaveLength(1));
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(calls("/api/dashboard")).toHaveLength(2));
    await waitFor(() => expect(calls("/api/spares")).toHaveLength(2));
  });

  // FR-DSH-011: the filter is the URL, so a depot view is a link.
  it("sends the depot from the URL", async () => {
    stubApi(dashboardBody({ scope: { level: "DEPOT", depotCount: 1, depot: "d1" } }));
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet", "ViewValuation"],
      withRouter: true,
      initialEntries: ["/?depot=d1"],
    });
    await screen.findByText("R16,537.50");
    expect(calls("/api/dashboard")).toContain("/api/dashboard?depot=d1");
  });

  // Radix shows its placeholder only for an empty value, so a depot named
  // in the URL would read as a blank trigger until the list answers.
  it("says the depots are loading, never a blank picker", async () => {
    const fetchMock = stubApi();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      if (url.startsWith("/api/depots")) return new Promise<Response>(() => undefined);
      if (url.startsWith("/api/dashboard")) return Promise.resolve(respond(200, dashboardBody()));
      return Promise.resolve(
        respond(200, { scope: dashboardBody().scope, judgedAt: "TENANT_TODAY", spares: [] }),
      );
    });
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      initialEntries: ["/?depot=d1"],
    });
    expect(screen.getByRole("combobox", { name: "Depot" })).toHaveTextContent("Loading depots");
    await screen.findByText("R16,537.50");
  });

  it("says the depots did not load, and the dashboard still renders", async () => {
    const fetchMock = stubApi();
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      if (url.startsWith("/api/depots")) {
        return Promise.resolve(respond(500, { code: "internal", message: "no" }));
      }
      if (url.startsWith("/api/dashboard")) return Promise.resolve(respond(200, dashboardBody()));
      return Promise.resolve(
        respond(200, { scope: dashboardBody().scope, judgedAt: "TENANT_TODAY", spares: [] }),
      );
    });
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      initialEntries: ["/?depot=d1"],
    });
    await screen.findByText("R16,537.50");
    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Depot" })).toHaveTextContent(
        "Depots did not load",
      );
    });
  });

  // TYRE-239 DoD, U42, U85, U87: a depot-scoped actor's figures are composed
  // in SQL (B7.2's depot-scope tests are that proof); the page names the
  // scope the server reported and offers only the actor's own DEPOT and
  // STORE depots, before a depot is chosen and after.
  it("offers a depot-scoped actor only their own depots, before and after choosing one", async () => {
    const user = userEvent.setup();
    stubDepotScopedApi();
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      actor: technician,
    });
    expect(await screen.findByText(/across your 2 depots$/)).toBeInTheDocument();
    await expectOwnDepotsOnly(user);
    await user.click(screen.getByRole("option", { name: "Johannesburg" }));
    await waitFor(() => expect(calls("/api/dashboard")).toContain("/api/dashboard?depot=d1"));
    expect(screen.getByRole("combobox", { name: "Depot" })).toHaveTextContent("Johannesburg");
    await expectOwnDepotsOnly(user);
  });

  // U87: the actor's breadth comes from GET /api/me, so a link straight to
  // a depot view, with no unfiltered read behind it, still narrows the list.
  it("narrows the picker for a depot-scoped actor who arrives on a depot view", async () => {
    const user = userEvent.setup();
    stubDepotScopedApi();
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      initialEntries: ["/?depot=d1"],
      actor: technician,
    });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Depot" })).toHaveTextContent("Johannesburg"),
    );
    expect(calls("/api/dashboard")).toEqual(["/api/dashboard?depot=d1"]);
    await expectOwnDepotsOnly(user);
  });

  it("explains a failed load and offers a retry, never a blank page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    renderWithActor(<Dashboard />, { capabilities: ["ViewFleet"], withRouter: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("The dashboard didn't load");
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });
});
