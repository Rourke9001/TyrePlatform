import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ReportedDifferences } from "./ReportedDifferences";
import { ActorContext } from "../../auth/actorContext";
import type { ReportedDifference } from "../../api/observations";
import { observationsKey } from "../unit/queryKeys";
import { me, requestedUrl, respond, sentBody, testQueryClient } from "../../test/fixtures";

function report(overrides: Partial<ReportedDifference> & { id: string }): ReportedDifference {
  return {
    inspectionId: "i1",
    startedAt: "2026-09-07T05:30:00Z",
    submittedAt: "2026-09-07T05:33:00Z",
    driver: { id: "d1", displayName: "Sipho" },
    rig: { id: "r1", motiveFleetNumber: "HORSE-1", members: ["HORSE-1", "LINK-1", "LINK-2"] },
    observed: ["HORSE-1", "LINK-1"],
    removed: ["LINK-2"],
    stale: false,
    ...overrides,
  };
}

// The client comes back too: the empty-list test needs a settle signal the
// query cache itself can answer (below), because "fetch was called" can be
// true before the mocked response has resolved — the pending state and the
// empty-list state both render nothing, so a check that passes on either one
// proves nothing about which branch ran.
function renderSection(capabilities: string[] = ["ViewFleet", "ManageAssignments"]) {
  const client = testQueryClient();
  const view = render(
    <ActorContext.Provider value={{ actor: me({ capabilities }), settled: true }}>
      <QueryClientProvider client={client}>
        <ReportedDifferences />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
  return { ...view, client };
}

describe("reported differences", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing when the list is empty", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, []));
    const { client } = renderSection();

    // The settle signal is the query cache's own status, not "fetch was
    // called": that fires before the mock's Promise chain has resolved, and
    // the pending state renders nothing too, so it would pass whether or not
    // the empty-list branch is the one that ran.
    await waitFor(() =>
      expect(client.getQueryState(observationsKey("default"))?.status).toBe("success"),
    );
    expect(screen.queryByRole("heading", { name: "Reported differences" })).not.toBeInTheDocument();
  });

  it("renders the driver's sentence", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [report({ id: "o1" })]));
    renderSection();

    expect(
      await screen.findByText(
        /Sipho reported on .* that LINK-2 was not coupled to HORSE-1's rig\./,
      ),
    ).toBeInTheDocument();
  });

  it("posts the note and re-fetches the list on Apply", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [report({ id: "o1" })]));
    renderSection();
    await screen.findByRole("button", { name: "Apply" });

    await userEvent.type(screen.getByLabelText("Note"), "seen in the yard");

    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, { resultingRigId: null }))
      .mockResolvedValueOnce(respond(200, []));
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBe(3));
    expect(requestedUrl(vi.mocked(fetch).mock.calls[1][0])).toBe(
      "/api/combinations/observations/o1/apply",
    );
    expect(sentBody(1)).toStrictEqual({ note: "seen in the yard" });
  });

  it("keeps Dismiss disabled until the note is non-blank", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [report({ id: "o1" })]));
    renderSection();
    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    expect(dismiss).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Note"), "   ");
    expect(dismiss).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Note"), "reason");
    expect(dismiss).toBeEnabled();
  });

  it("offers no Apply on a stale report", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [report({ id: "o1", stale: true })]));
    renderSection();

    await screen.findByRole("button", { name: "Dismiss" });
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.getByText("This rig has since ended; dismiss the report.")).toBeInTheDocument();
  });

  it("shows the sentence and no controls to a ViewFleet-only reader", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [report({ id: "o1" })]));
    renderSection(["ViewFleet"]);

    expect(
      await screen.findByText(
        /Sipho reported on .* that LINK-2 was not coupled to HORSE-1's rig\./,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Note")).not.toBeInTheDocument();
  });
});
