import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { RetreadQueue } from "./RetreadQueue";
import { ActorContext } from "../auth/actorContext";
import type { RetreadJob } from "../api/retreads";
import { me, requestedUrl, respond, sentBody, testQueryClient } from "../test/fixtures";

function job(overrides: Partial<RetreadJob> & { id: string }): RetreadJob {
  return {
    tyreId: "t1",
    displayCode: "POS1",
    depotName: "Retread Co",
    sentAt: "2026-08-01",
    daysOut: 5,
    ...overrides,
  };
}

function renderScreen() {
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities: ["LogRetread"] }), settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <MemoryRouter>
          <RetreadQueue />
        </MemoryRouter>
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

describe("the retread queue", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders each job's days out from the server, never computed here", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [job({ id: "j1", daysOut: 12 })]));
    renderScreen();

    const row = (await screen.findByRole("rowheader", { name: "POS1" })).closest("tr");
    if (!row) throw new Error("row for POS1 not found");
    expect(within(row).getByText("12")).toBeInTheDocument();
  });

  // 2026-08-26 lesson: literal inputs, unrounded, exactly as typed — the
  // database rounds.
  it("posts the accepted body with money as strings", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, [job({ id: "j1" })]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      // The success invalidates ["retread-jobs"], and this screen's own
      // query is an active observer of it, so it refetches immediately.
      .mockResolvedValueOnce(respond(200, [job({ id: "j1" })]));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Accepted" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-1");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.type(screen.getByLabelText(/retread cost for pos1/i), "2500.005");
    await user.type(screen.getByLabelText(/post-tread for pos1/i), "16");
    await user.type(screen.getByLabelText(/casing value for pos1/i), "800");
    await user.click(screen.getByRole("button", { name: /log return/i }));

    // A success invalidates ["retread-jobs"], and this screen's own query is
    // an active observer, so a third refetch call can land before this
    // check runs — asserted by position (call 1 is the return write), not
    // by a total the refetch would otherwise race.
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(requestedUrl(vi.mocked(fetch).mock.calls[1][0])).toBe("/api/retread-jobs/j1/return");
    expect(sentBody(1)).toStrictEqual({
      returnedOn: "2026-08-20",
      casingAccepted: true,
      reportReference: "RPT-1",
      retreadCost: "2500.005",
      postTreadMm: "16",
      casingValue: "800",
    });
  });

  it("posts the rejected body without a cost or a casing value", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, [job({ id: "j1" })]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(respond(200, [job({ id: "j1" })]));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Rejected" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-2");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.click(screen.getByRole("button", { name: /log return/i }));

    // A success invalidates ["retread-jobs"], and this screen's own query is
    // an active observer, so a third refetch call can land before this
    // check runs — asserted by position (call 1 is the return write), not
    // by a total the refetch would otherwise race.
    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(requestedUrl(vi.mocked(fetch).mock.calls[1][0])).toBe("/api/retread-jobs/j1/return");
    const body = sentBody(1) as Record<string, unknown>;
    expect(body).toStrictEqual({
      returnedOn: "2026-08-20",
      casingAccepted: false,
      reportReference: "RPT-2",
    });
    expect("retreadCost" in body).toBe(false);
    expect("casingValue" in body).toBe(false);
  });

  it("shows an explicit success line once the return is logged", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, [job({ id: "j1" })]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(respond(200, [job({ id: "j1" })]));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Rejected" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-3");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.click(screen.getByRole("button", { name: /log return/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/pos1's return was logged/i);
  });

  it("links back to the register", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, []));
    renderScreen();

    expect(await screen.findByRole("link", { name: /back to register/i })).toHaveAttribute(
      "href",
      "/fleet/tyres",
    );
  });

  it("shows a note card when no casings are out for retread", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, []));
    renderScreen();

    expect(await screen.findByText(/no casings are out for retread/i)).toBeInTheDocument();
  });
});
