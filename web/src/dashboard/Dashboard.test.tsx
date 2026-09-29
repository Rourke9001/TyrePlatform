import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDevTenantId } from "../api/devTenant";
import { ActorContext } from "../auth/actorContext";
import { dashboardBody, me, renderWithActor, requestedUrl, respond } from "../test/fixtures";
import Dashboard from "./Dashboard";

// U41's retry option only matters against a client that has not already
// turned retries off. renderWithActor's testQueryClient does that (fixtures.ts),
// so this wrapper takes the library's own defaults instead, the way
// renderWithActor builds its providers but with a plain QueryClient.
function renderWithDefaultRetries(ui: ReactElement) {
  const client = new QueryClient();
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities: ["ViewFleet"] }), settled: true }}>
      <QueryClientProvider client={client}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

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

// U87: role and scope disagree with auth.go's table on purpose, so a
// TypeScript copy of that table fails where reading me.scope passes.
const tenantWideTechnician = { role: "TECHNICIAN", depots: ["d1"], scope: "TENANT" };
const depotScopedController = { role: "CONTROLLER", depots: ["d1"], scope: "DEPOT" };

// What the server sends: analytics.go answers TENANT_ONLY, with no window
// and no bands, for any ?depot= request and any depot-scoped actor, and
// valuation.go nulls every money string when money is hidden.
function wireBody(overrides: Parameters<typeof dashboardBody>[0], tenantOnly: boolean) {
  const body = dashboardBody(overrides);
  const { running, spare } = body.valueAtRisk;
  return {
    ...body,
    inflationCompliance: tenantOnly
      ? { from: null, to: null, windowDays: null, unavailable: "TENANT_ONLY", bands: [] }
      : body.inflationCompliance,
    ...(body.moneyVisible
      ? {}
      : {
          valueAtRisk: {
            ...body.valueAtRisk,
            running: { ...running, casingValueAtRisk: null },
            spare: { ...spare, casingValueAtRisk: null },
          },
          estate: { ...body.estate, treadValue: null, casingValue: null, totalValue: null },
        }),
  };
}

const tenantDepots = [
  { id: "d1", name: "Johannesburg", type: "DEPOT" },
  { id: "d2", name: "Durban", type: "STORE" },
  { id: "d3", name: "Cape Town", type: "DEPOT" },
  { id: "r1", name: "Retreaders", type: "RETREADER" },
];

// depotScoped is the server's reading of the actor, which decides the
// unfiltered body's scope and inflation. depotCount is len(a.DepotIDs),
// every user_depot row of any type (scope.go), so the technician's is 3.
function stubDepotScopedApi({ depotScoped = true, depotCount = 3 } = {}) {
  const fetchMock = stubApi();
  const scope = depotScoped
    ? { level: "DEPOTS", depotCount, depot: null }
    : { level: "TENANT", depotCount: 0, depot: null };
  fetchMock.mockImplementation((input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (url === "/api/dashboard") {
      return Promise.resolve(respond(200, wireBody({ scope, moneyVisible: false }, depotScoped)));
    }
    if (url.startsWith("/api/dashboard?depot=")) {
      return Promise.resolve(
        respond(
          200,
          wireBody(
            { scope: { level: "DEPOT", depotCount: 1, depot: "d1" }, moneyVisible: false },
            true,
          ),
        ),
      );
    }
    if (url.startsWith("/api/depots")) return Promise.resolve(respond(200, tenantDepots));
    return Promise.resolve(respond(200, { scope, judgedAt: "TENANT_TODAY", spares: [] }));
  });
}

// Opens the picker and waits for the depots to arrive in it, then reads
// the exact set offered: the count, and each option by its name.
async function expectPickerOffers(user: ReturnType<typeof userEvent.setup>, names: string[]) {
  const picker = screen.getByRole("combobox", { name: "Depot" });
  picker.focus();
  await user.keyboard("{Enter}");
  await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(names.length));
  for (const name of names) {
    expect(screen.getByRole("option", { name })).toBeInTheDocument();
  }
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

  // U41: a focus toggle must not add a second call. In query-core's
  // shouldFetchOn, refetchOnWindowFocus: false short-circuits before
  // staleness is checked, and staleTime: Infinity keeps the query from
  // being stale if that check is reached, so either option alone already
  // blocks the refetch; this test fails only when both are gone.
  it("does not refetch when the window regains focus (U41)", async () => {
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet", "ViewValuation"],
      withRouter: true,
    });
    await screen.findByText("R16,537.50");
    expect(calls("/api/dashboard")).toHaveLength(1);
    try {
      // The client's focus subscriber is async (queryClient.js's mount()),
      // so a refetch it issues lands a microtask later; the awaits below
      // drain that queue before the assertion reads calls().
      await act(async () => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(calls("/api/dashboard")).toHaveLength(1);
    } finally {
      // A later test's own focus state must not inherit this one's toggle.
      focusManager.setFocused(undefined);
    }
  });

  // U41: retry: 0 is the query's own option, not a reliance on the test
  // client's retry: false (fixtures.ts's testQueryClient). A default
  // QueryClient here proves the option, not the harness, stops the retries;
  // without it the alert would wait out three backed-off attempts.
  it("does not retry a failed load (U41)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
    renderWithDefaultRetries(<Dashboard />);
    expect(await screen.findByRole("alert")).toHaveTextContent("The dashboard didn't load");
    expect(calls("/api/dashboard")).toHaveLength(1);
  });

  // FR-DSH-011: the filter is the URL, so a depot view is a link.
  it("sends the depot from the URL", async () => {
    stubApi(wireBody({ scope: { level: "DEPOT", depotCount: 1, depot: "d1" } }, true));
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet", "ViewValuation"],
      withRouter: true,
      initialEntries: ["/?depot=d1"],
    });
    await screen.findByText("R16,537.50");
    expect(calls("/api/dashboard")).toContain("/api/dashboard?depot=d1");
    await waitFor(() => expect(calls("/api/spares")).toContain("/api/spares?depot=d1"));
    // U44: me()'s default actor is tenant-wide, so it can widen again.
    expect(
      screen.getByText("Tenant-wide only. Clear the depot filter to see it."),
    ).toBeInTheDocument();
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
    expect(await screen.findByText(/across your 3 depots$/)).toBeInTheDocument();
    expect(screen.getByText("Not available for a depot view yet.")).toBeInTheDocument();
    await expectPickerOffers(user, ["All my depots", "Johannesburg", "Durban"]);
    await user.click(screen.getByRole("option", { name: "Johannesburg" }));
    await waitFor(() => expect(calls("/api/dashboard")).toContain("/api/dashboard?depot=d1"));
    expect(screen.getByRole("combobox", { name: "Depot" })).toHaveTextContent("Johannesburg");
    expect(await screen.findByText("Not available for a depot view yet.")).toBeInTheDocument();
    await expectPickerOffers(user, ["All my depots", "Johannesburg", "Durban"]);
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
    expect(await screen.findByText("Not available for a depot view yet.")).toBeInTheDocument();
    await expectPickerOffers(user, ["All my depots", "Johannesburg", "Durban"]);
  });

  // U87 (TYRE-239 comment 13340): the breadth is me.scope, never the role.
  it("offers a tenant-wide actor every depot and store whatever the role", async () => {
    const user = userEvent.setup();
    stubDepotScopedApi({ depotScoped: false });
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      actor: tenantWideTechnician,
    });
    await screen.findByText(/^As at /);
    await expectPickerOffers(user, ["All depots", "Johannesburg", "Durban", "Cape Town"]);
  });

  it("offers a depot-scoped actor their own depots whatever the role", async () => {
    const user = userEvent.setup();
    stubDepotScopedApi({ depotCount: 1 });
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      actor: depotScopedController,
    });
    await screen.findByText(/across your 1 depot$/);
    await expectPickerOffers(user, ["All my depots", "Johannesburg"]);
  });

  // U44, U87: on a depot view only a tenant-wide actor can clear the filter
  // to a figure, so only they are told to.
  it("words the tenant-only inflation by the actor's scope, not the role", async () => {
    stubDepotScopedApi({ depotScoped: false });
    const { unmount } = renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      initialEntries: ["/?depot=d1"],
      actor: tenantWideTechnician,
    });
    expect(
      await screen.findByText("Tenant-wide only. Clear the depot filter to see it."),
    ).toBeInTheDocument();
    unmount();
    stubDepotScopedApi({ depotCount: 1 });
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      initialEntries: ["/?depot=d1"],
      actor: depotScopedController,
    });
    expect(await screen.findByText("Not available for a depot view yet.")).toBeInTheDocument();
    expect(screen.queryByText(/Clear the depot filter/)).toBeNull();
  });

  // FR-DSH-013, H.3 criterion 6: the lists the tiles link to are marked
  // stale with the dashboard, so the hero and the at-risk list it opens
  // never show two different registers.
  it("marks the exceptions and at-risk lists stale when Refresh is pressed", async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    try {
      renderWithActor(<Dashboard />, {
        capabilities: ["ViewFleet", "ViewValuation"],
        withRouter: true,
      });
      await screen.findByText("R16,537.50");
      await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
      const tenantKey = getDevTenantId() ?? "default";
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["exceptions", tenantKey] });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["at-risk", tenantKey] });
    } finally {
      invalidate.mockRestore();
    }
  });

  // U55: one depot is singular.
  it("names one depot in the singular", async () => {
    stubApi(dashboardBody({ scope: { level: "DEPOTS", depotCount: 1, depot: null } }));
    renderWithActor(<Dashboard />, { capabilities: ["ViewFleet"], withRouter: true });
    expect(await screen.findByText(/across your 1 depot$/)).toBeInTheDocument();
  });

  // U44, U48: an empty estate says so once, in the vocabulary's words.
  it("names an empty estate", async () => {
    const estate = dashboardBody().estate;
    stubApi(
      dashboardBody({
        estate: {
          ...estate,
          tyreCount: 0,
          actualCount: 0,
          casingAuditCount: 0,
          treadValue: null,
          casingValue: null,
          totalValue: null,
        },
      }),
    );
    renderWithActor(<Dashboard />, { capabilities: ["ViewFleet"], withRouter: true });
    expect(
      await screen.findByRole("heading", { level: 2, name: "No tyres in this view" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Nothing is fitted or in stock here, so there is nothing to value."),
    ).toBeInTheDocument();
  });

  // U87 fails closed: a breadth this client does not know is offered only
  // the actor's own depots, as the server and the inflation wording read it.
  it("offers an actor of an unknown breadth only their own depots", async () => {
    const user = userEvent.setup();
    stubDepotScopedApi();
    renderWithActor(<Dashboard />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      actor: { role: "CONTROLLER", depots: ["d1"], scope: "REGION" },
    });
    await screen.findByText(/^As at /);
    await expectPickerOffers(user, ["All my depots", "Johannesburg"]);
  });

  it("explains a failed load and offers a retry, never a blank page", async () => {
    const fetchMock = stubApi();
    const answer = fetchMock.getMockImplementation();
    let failed = false;
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      if (!failed && requestedUrl(input).startsWith("/api/dashboard")) {
        failed = true;
        return Promise.reject(new TypeError("Failed to fetch"));
      }
      return answer ? answer(input) : Promise.reject(new Error("no stub"));
    });
    renderWithActor(<Dashboard />, { capabilities: ["ViewFleet"], withRouter: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("The dashboard didn't load");
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("R16,537.50")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
