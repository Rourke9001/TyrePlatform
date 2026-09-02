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

  // sentAt is genuinely date-only on the wire (retreads.go's own
  // `sent_at::text` select, a date column) and renders in UTC unshifted;
  // daysOut is the server's own arithmetic, rendered as given.
  it("renders sent on through useTenantDate and days out from the server", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [job({ id: "j1", sentAt: "2026-08-01", daysOut: 12 })]),
    );
    renderScreen();

    const row = (await screen.findByRole("rowheader", { name: "POS1" })).closest("tr");
    if (!row) throw new Error("row for POS1 not found");
    expect(within(row).getByText("01 Aug 2026")).toBeInTheDocument();
    expect(within(row).getByText("12")).toBeInTheDocument();
  });

  it("hides the money inputs when Rejected is chosen", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [job({ id: "j1" })]));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Rejected" }));

    expect(screen.queryByLabelText(/retread cost for pos1/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/post-tread for pos1/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/casing value for pos1/i)).not.toBeInTheDocument();
  });

  // ReceiveTyre.test.tsx's own technique: a real click on "Log return" never
  // reaches this handler while reportReference/returnedOn's `required`
  // attributes are unmet — jsdom's constraint validation intercepts it
  // first — so fireEvent.submit dispatches the "submit" event directly,
  // proving the guard independently of those attributes.
  it("shows a local refusal, not a silent no-op, when required fields are missing", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [job({ id: "j1" })]));
    const user = userEvent.setup();
    const { container } = renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Accepted" }));
    const form = container.querySelector("form");
    if (form === null) throw new Error("expected a form element");
    fireEvent.submit(form);

    expect(await screen.findByRole("alert")).toHaveTextContent(/before a return can be logged/i);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
  });

  // 2026-08-26 lesson: literal inputs, unrounded, exactly as typed — the
  // database rounds. `open=true` excludes a closed job, so the refetch
  // after a success returns the server's real answer — an empty list — and
  // every post-write refetch below mocks that, not the job still open.
  it("posts the accepted body with money as strings", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, [job({ id: "j1" })]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(respond(200, []));
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
      .mockResolvedValueOnce(respond(200, []));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Rejected" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-2");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.click(screen.getByRole("button", { name: /log return/i }));

    await waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(requestedUrl(vi.mocked(fetch).mock.calls[1][0])).toBe("/api/retread-jobs/j1/return");
    expect(sentBody(1)).toStrictEqual({
      returnedOn: "2026-08-20",
      casingAccepted: false,
      reportReference: "RPT-2",
    });
  });

  // The confirmation lives at RetreadQueue, not inside the row — the same
  // refetch that surfaces it also removes the closed job's row, proving the
  // message did not come from a row still on screen.
  it("shows the confirmation once the job's own row has left the list on the refetch", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, [job({ id: "j1" })]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(respond(200, []));
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Rejected" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-3");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.click(screen.getByRole("button", { name: /log return/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/the return for pos1 was logged/i);
    expect(screen.queryByRole("rowheader", { name: "POS1" })).not.toBeInTheDocument();
  });

  // TY015's own sentence is the whole content of the refusal (NFR-USE-005) —
  // rendered verbatim, not replaced by a general one — mirroring
  // DispatchForm.test.tsx's own TY015 case.
  it("renders TY015's message verbatim when the casing is at its retread cap", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, [job({ id: "j1" })]))
      .mockResolvedValueOnce(
        respond(422, {
          code: "TY015",
          message:
            "this casing has been retreaded 4 time(s), at a cap of 4; at its cap it is a purchase, not a retread candidate",
        }),
      );
    const user = userEvent.setup();
    renderScreen();
    await screen.findByRole("rowheader", { name: "POS1" });

    await user.click(screen.getByRole("radio", { name: "Accepted" }));
    await user.type(screen.getByLabelText(/report reference for pos1/i), "RPT-4");
    fireEvent.change(screen.getByLabelText(/returned on for pos1/i), {
      target: { value: "2026-08-20" },
    });
    await user.type(screen.getByLabelText(/retread cost for pos1/i), "2500");
    await user.type(screen.getByLabelText(/post-tread for pos1/i), "16");
    await user.type(screen.getByLabelText(/casing value for pos1/i), "800");
    await user.click(screen.getByRole("button", { name: /log return/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /a purchase, not a retread candidate/i,
    );
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
