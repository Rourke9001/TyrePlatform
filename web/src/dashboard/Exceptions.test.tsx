import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExceptionRow } from "../api/dashboard";
import { exceptionRow, renderWithActor, requestedUrl, respond } from "../test/fixtures";
import { forceMatchMedia } from "../test/media";
import Exceptions from "./Exceptions";

// The BAC capture's own rules: a tread below threshold, irregular wear, a
// dual-mate pair in mm and a pressure rule in %, and one row a fitment has
// resolved since, which exceptions.go sends only when includeResolved is
// set.
const rows = [
  exceptionRow({ subjectId: "a" }),
  exceptionRow({
    subjectId: "b",
    ruleCode: "FR-EXC-035",
    ruleName: "Irregular wear across the tread",
    severity: "WARNING",
    urgent: false,
    positionCode: "5",
    displayCode: "2102BAC5",
    measureMm: 4,
    thresholdMm: 4,
  }),
  exceptionRow({
    subjectId: "c",
    ruleCode: "FR-EXC-036",
    ruleName: "Dual-mate mismatch",
    severity: "WARNING",
    urgent: false,
    subjectType: "POSITION_PAIR",
    fleetNumber: "LINK6",
    positionCode: "8",
    positionCode2: "7",
    measureMm: 7,
    thresholdMm: 3,
  }),
  exceptionRow({
    subjectId: "d",
    ruleCode: "FR-EXC-022",
    ruleName: "Pressure dangerously under",
    fleetNumber: "LINK6",
    positionCode: "6",
    measureMm: null,
    thresholdMm: null,
    measurePct: 26.666666666666668,
    thresholdPct: 80,
  }),
  exceptionRow({
    subjectId: "e",
    positionCode: "8",
    displayCode: "2102BAC8",
    resolvedByFitment: true,
  }),
];

function stubExceptions(served: ExceptionRow[] = rows, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      if (url.startsWith("/api/exceptions")) {
        if (status !== 200) {
          return Promise.resolve(respond(status, { code: "internal", message: "no" }));
        }
        const withResolved = url.includes("includeResolved=true");
        return Promise.resolve(
          respond(200, {
            scope: { level: "TENANT", depotCount: 0, depot: null },
            judgedAt: "SUBMITTED_AT",
            exceptions: served.filter((r) => withResolved || !r.resolvedByFitment),
          }),
        );
      }
      if (url.startsWith("/api/depots")) {
        return Promise.resolve(respond(200, [{ id: "d1", name: "Johannesburg", type: "DEPOT" }]));
      }
      return Promise.resolve(respond(404, { code: "not_found", message: "no" }));
    }),
  );
}

beforeEach(() => {
  stubExceptions();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Exceptions", () => {
  it("lists every row with the rule, the severity as a word, the measure against its threshold and the clock", async () => {
    renderWithActor(<Exceptions />, { capabilities: ["ViewFleet"], withRouter: true });
    const table = await screen.findByRole("table", { name: "Exceptions" });
    // DataTable keeps its frame while loading, with four skeleton rows under
    // aria-busy, so the assertions wait for the data, not the frame.
    await waitFor(() => expect(table).not.toHaveAttribute("aria-busy"));
    expect(within(table).getAllByRole("row")).toHaveLength(5);
    expect(
      within(table).getByRole("cell", { name: "Irregular wear across the tread FR-EXC-035" }),
    ).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "1.0 mm of 4.0 mm" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "7.0 mm of 3.0 mm" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "27% of 80%" })).toBeInTheDocument();
    expect(within(table).getByRole("cell", { name: "8 and 7" })).toBeInTheDocument();
    expect(within(table).getAllByText("Warning")).toHaveLength(2);
    expect(within(table).getAllByRole("cell", { name: "23 Jul 2026 07:46" })).toHaveLength(4);
    expect(within(table).getAllByRole("cell", { name: "No" })).toHaveLength(4);
    expect(screen.getByText("4 exceptions, as inspected")).toBeInTheDocument();
    // Rule 6: the zone is named once, under the table.
    expect(screen.getByText(/^Times are Africa\/Johannesburg\./)).toBeInTheDocument();
  });

  it("sends the URL's filters to the API", async () => {
    renderWithActor(<Exceptions />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      initialEntries: ["/exceptions?severity=CRITICAL&rule=FR-EXC-020&resolved=true"],
    });
    await screen.findByRole("table", { name: "Exceptions" });
    const calls = vi.mocked(fetch).mock.calls.map((c) => requestedUrl(c[0]));
    expect(calls).toContain(
      "/api/exceptions?severity=CRITICAL&rule=FR-EXC-020&includeResolved=true",
    );
  });

  // U14, FR-EXC-010: a row a fitment resolved is shown only when asked
  // for, and says it was replaced.
  it("shows a replaced row only when replaced rows are included", async () => {
    renderWithActor(<Exceptions />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      initialEntries: ["/exceptions?resolved=true"],
    });
    const table = await screen.findByRole("table", { name: "Exceptions" });
    await waitFor(() => expect(table).not.toHaveAttribute("aria-busy"));
    expect(within(table).getAllByRole("row")).toHaveLength(6);
    expect(within(table).getByRole("cell", { name: "Yes" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Include replaced" })).toBeChecked();
  });

  // U17: a filter changed on a depot view keeps the depot.
  it("keeps the depot when the severity changes", async () => {
    const user = userEvent.setup();
    renderWithActor(<Exceptions />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      initialEntries: ["/exceptions?depot=d1"],
    });
    await screen.findByText("4 exceptions, as inspected, at Johannesburg");
    const severity = screen.getByRole("combobox", { name: "Severity" });
    severity.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("option", { name: "Critical" }));
    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.map((c) => requestedUrl(c[0]));
      expect(calls.filter((u) => u.startsWith("/api/exceptions")).at(-1)).toBe(
        "/api/exceptions?severity=CRITICAL&depot=d1",
      );
    });
  });

  it("explains a failed load rather than an empty list", async () => {
    stubExceptions(rows, 500);
    renderWithActor(<Exceptions />, { capabilities: ["ViewFleet"], withRouter: true });
    expect(await screen.findByRole("alert")).toHaveTextContent("The exceptions list did not load.");
    expect(screen.queryByText("No open exceptions")).toBeNull();
  });

  // U17: a depot view arrives from a dashboard link and says so.
  it("names the depot a link from the dashboard narrowed it to", async () => {
    renderWithActor(<Exceptions />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      initialEntries: ["/exceptions?depot=d1"],
    });
    expect(
      await screen.findByText("4 exceptions, as inspected, at Johannesburg"),
    ).toBeInTheDocument();
    const calls = vi.mocked(fetch).mock.calls.map((c) => requestedUrl(c[0]));
    expect(calls).toContain("/api/exceptions?depot=d1");
  });

  // U55: one exception is singular.
  it("counts one exception in the singular", async () => {
    stubExceptions([rows[0]]);
    renderWithActor(<Exceptions />, { capabilities: ["ViewFleet"], withRouter: true });
    expect(await screen.findByText("1 exception, as inspected")).toBeInTheDocument();
  });

  // U48: an empty list says what is absent, in the accepted mockup's words.
  it("names an empty list", async () => {
    stubExceptions([]);
    renderWithActor(<Exceptions />, { capabilities: ["ViewFleet"], withRouter: true });
    expect(
      await screen.findByRole("heading", { level: 2, name: "No open exceptions" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Nothing the configured rules flag at the latest inspection of any unit in this view.",
      ),
    ).toBeInTheDocument();
  });

  describe("on a phone", () => {
    let restore: () => void;

    beforeEach(() => {
      restore = forceMatchMedia(true);
    });

    afterEach(() => {
      restore();
    });

    // The page's own list sits directly under its h1, so each card is
    // headed at level 2 (TYRE-239 comment 12978).
    it("heads each card at level 2", async () => {
      renderWithActor(<Exceptions />, { capabilities: ["ViewFleet"], withRouter: true });
      const list = await screen.findByRole("list", { name: "Exceptions" });
      await waitFor(() => expect(list).not.toHaveAttribute("aria-busy"));
      expect(within(list).getAllByRole("heading", { level: 2 })).toHaveLength(4);
    });
  });
});
