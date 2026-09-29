import { screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardBody, renderWithActor, requestedUrl, respond, spareRow } from "../test/fixtures";
import { DashboardPanels } from "./DashboardPanels";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      if (url.startsWith("/api/spares")) {
        return Promise.resolve(
          respond(200, {
            scope: { level: "TENANT", depotCount: 0, depot: null },
            judgedAt: "TENANT_TODAY",
            spares: [spareRow({ tyreId: "s1" })],
          }),
        );
      }
      return Promise.resolve(respond(404, { code: "not_found", message: "no" }));
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const follows = (a: Node, b: Node) =>
  (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe("DashboardPanels", () => {
  // The accepted mockup's order: inflation across the width, then the chart
  // with its two tiles beside it, then the spares.
  it("lays the panels out in the accepted mockup's order", async () => {
    renderWithActor(<DashboardPanels body={dashboardBody()} depotFiltered={false} />, {
      withRouter: true,
    });
    const inflation = screen.getByRole("region", { name: "Inflation compliance" });
    const chart = screen.getByRole("region", { name: "Tread depth" });
    const forecast = screen.getByRole("article", { name: "Replacement window opens" });
    const spares = await screen.findByRole("region", { name: "Spares" });
    expect(follows(inflation, chart)).toBe(true);
    expect(follows(chart, forecast)).toBe(true);
    expect(follows(forecast, spares)).toBe(true);
  });

  // FR-DSH-007, U86, rule 6: the configured window as the two dates the
  // server chose, in the tenant's calendar; every band named in words
  // (TYRE-271) and a null share named, never 0%.
  it("renders the inflation window and its bands in words, with a null share named", () => {
    renderWithActor(<DashboardPanels body={dashboardBody()} depotFiltered={false} />, {
      withRouter: true,
    });
    const panel = screen.getByRole("region", { name: "Inflation compliance" });
    expect(
      within(panel).getByText(
        /^Configured window: 30 days, 24 Aug 2026 to 23 Sept? 2026\. The end date is excluded\.$/,
      ),
    ).toBeInTheDocument();
    expect(within(panel).getAllByRole("cell", { name: "none classified" })).toHaveLength(5);
    expect(
      within(panel).getByRole("cell", { name: "Critically under target" }),
    ).toBeInTheDocument();
    expect(within(panel).queryByText("dangerously_under")).toBeNull();
  });

  // U52: a chosen period has no configured length, only its two dates.
  it("names a chosen period by its dates", () => {
    const base = dashboardBody().inflationCompliance;
    const body = dashboardBody({
      inflationCompliance: { ...base, from: "2026-07-01", to: "2026-08-01", windowDays: null },
    });
    renderWithActor(<DashboardPanels body={body} depotFiltered={false} />, { withRouter: true });
    expect(
      screen.getByText(/^Chosen period: 01 Jul 2026 to 01 Aug 2026\. The end date is excluded\.$/),
    ).toBeInTheDocument();
  });

  // U32, U44: TENANT_ONLY has two wordings, by who asked.
  it("tells a depot-filtered reader to clear the filter and a depot actor it is not there yet", () => {
    const body = dashboardBody({
      inflationCompliance: {
        from: null,
        to: null,
        windowDays: null,
        unavailable: "TENANT_ONLY",
        bands: [],
      },
    });
    const { unmount } = renderWithActor(<DashboardPanels body={body} depot="d1" depotFiltered />, {
      withRouter: true,
    });
    expect(
      screen.getByText("Tenant-wide only. Clear the depot filter to see it."),
    ).toBeInTheDocument();
    unmount();
    renderWithActor(<DashboardPanels body={body} depotFiltered={false} />, { withRouter: true });
    expect(screen.getByText("Not available for a depot view yet.")).toBeInTheDocument();
  });

  // FR-DSH-008, U40: the chart's words are the bounds; bandLabel never renders.
  it("draws the tread bands from their bounds", () => {
    renderWithActor(<DashboardPanels body={dashboardBody()} depotFiltered={false} />, {
      withRouter: true,
    });
    const panel = screen.getByRole("region", { name: "Tread depth" });
    expect(
      within(panel).getByRole("img", { name: "0 to under 5 mm: 10 tyres, 37%" }),
    ).toBeInTheDocument();
    expect(within(panel).queryByText("0-4mm")).toBeNull();
  });

  // FR-DSH-009 and 016, beside the chart, each on its own clock.
  it("renders the forecast and irregular-wear tiles with the window's date and the configured spread", () => {
    renderWithActor(<DashboardPanels body={dashboardBody()} depot="d1" depotFiltered={false} />, {
      withRouter: true,
    });
    const forecast = screen.getByRole("article", { name: "Replacement window opens" });
    expect(forecast).toHaveAttribute("data-requirement", "FR-DSH-009");
    expect(forecast).toHaveTextContent(/within 30 days of 22 Sept? 2026/);
    expect(forecast).toHaveTextContent("today");
    const wear = screen.getByRole("article", { name: "Irregular wear" });
    expect(wear).toHaveTextContent(
      "running positions with a spread of 4.0 mm or more; 1 spare disclosed separately",
    );
    expect(wear).toHaveTextContent("at the latest reading");
    expect(within(wear).getByRole("link", { name: "See the list" })).toHaveAttribute(
      "href",
      "/exceptions?rule=FR-EXC-035&depot=d1",
    );
  });

  // Rule 5, U48: an unconfigured horizon or spread is a configuration
  // absence with its own words, never a 0.
  it("names an unconfigured horizon and spread instead of showing 0", () => {
    renderWithActor(
      <DashboardPanels
        body={dashboardBody({
          removalForecast: {
            horizonDays: null,
            from: "2026-09-22",
            unavailable: "NO_HORIZON",
            judgedAt: "TODAY",
            dueCount: null,
          },
          irregularWear: { judgedAt: "LATEST_READING", spreadWarnMm: null, running: 0, spare: 0 },
        })}
        depotFiltered={false}
      />,
      { withRouter: true },
    );
    expect(screen.getByRole("article", { name: "Replacement window opens" })).toHaveTextContent(
      "No forecast horizon is configured for this tenant.",
    );
    expect(screen.getByRole("article", { name: "Irregular wear" })).toHaveTextContent(
      "No width spread is configured for this tenant.",
    );
  });

  // FR-DSH-019: the dedicated list, its own query, its own clock.
  it("lists the spares from their own endpoint", async () => {
    renderWithActor(<DashboardPanels body={dashboardBody()} depotFiltered={false} />, {
      withRouter: true,
    });
    const panel = await screen.findByRole("region", { name: "Spares" });
    expect(await within(panel).findByRole("cell", { name: "2102BACS" })).toBeInTheDocument();
    expect(panel).toHaveTextContent("on the tenant's calendar day");
    expect(within(panel).getByRole("cell", { name: "2.0 mm" })).toBeInTheDocument();
    expect(within(panel).getByRole("cell", { name: "inspection reading" })).toBeInTheDocument();
    expect(within(panel).getByRole("cell", { name: "23 Jul 2026" })).toBeInTheDocument();
    expect(within(panel).getByRole("cell", { name: "935" })).toBeInTheDocument();
  });
});
