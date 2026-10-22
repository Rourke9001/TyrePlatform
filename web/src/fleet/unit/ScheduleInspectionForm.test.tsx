import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ScheduleInspectionForm } from "./ScheduleInspectionForm";
import { ActorContext } from "../../auth/actorContext";
import type { UnitTask } from "../../api/tasks";
import type { Driver, UnitTrip } from "../../api/trips";
import { me, requestedUrl, respond, sentBody, testQueryClient, unit } from "../../test/fixtures";

const UNIT = unit({ id: "u9", fleetNumber: "TRAILER-9" });

const DRIVERS: Driver[] = [
  { userId: "d1", displayName: "Sandbox Driver", staffNumber: null, onTrip: null },
];

const NO_TRIP: UnitTrip = { trip: null, pulledBy: null };

function task(overrides: Partial<UnitTask> & { id: string }): UnitTask {
  return {
    vehicleId: "u9",
    fleetNumber: "TRAILER-9",
    dueAt: "2026-09-04T22:30:00Z",
    state: "OPEN",
    overdue: false,
    escalated: false,
    responsibleUserId: "d1",
    responsibleDisplayName: "Sandbox Driver",
    responsibleVia: "NOMINATION",
    ...overrides,
  };
}

// Every read and the write by URL, so the order the panel's reads go out in
// cannot decide a test.
function stub(opts: { trip?: UnitTrip; drivers?: () => Response; post?: () => Response } = {}) {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestedUrl(input);
    if (url === "/api/vehicles/u9/trip") return Promise.resolve(respond(200, opts.trip ?? NO_TRIP));
    if (url === "/api/drivers")
      return Promise.resolve(opts.drivers ? opts.drivers() : respond(200, DRIVERS));
    if (url === "/api/vehicles/u9/inspection-tasks" && init?.method === "POST" && opts.post) {
      return Promise.resolve(opts.post());
    }
    throw new Error(`unstubbed ${url}`);
  });
}

function postIndex(): number {
  return vi
    .mocked(fetch)
    .mock.calls.findIndex(
      (c) => requestedUrl(c[0]) === "/api/vehicles/u9/inspection-tasks" && c[1]?.method === "POST",
    );
}

function renderForm() {
  return render(
    <ActorContext.Provider
      value={{ actor: me({ capabilities: ["ViewFleet", "ManageAssignments"] }), settled: true }}
    >
      <QueryClientProvider client={testQueryClient()}>
        <ScheduleInspectionForm unit={UNIT} />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

describe("scheduling an inspection", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says who the inspection goes to on a unit a trip covers, and offers no picker", async () => {
    stub({
      trip: {
        pulledBy: { vehicleId: "u1", fleetNumber: "HORSE-1" },
        trip: {
          id: "tr1",
          motive: { vehicleId: "u1", fleetNumber: "HORSE-1" },
          driver: { userId: "d1", displayName: "Melusi" },
          startedAt: "2026-09-01T06:00:00Z",
          startedBy: null,
          endedAt: null,
          trailers: [{ vehicleId: "u9", fleetNumber: "TRAILER-9" }],
        },
      },
    });
    renderForm();

    expect(
      await screen.findByText("This inspection goes to Melusi, on the trip with HORSE-1."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/^driver$/i)).toBeNull();
  });

  it("offers the driver picker with Nobody yet first on a unit no trip covers", async () => {
    stub();
    renderForm();

    await screen.findByRole("option", { name: "Sandbox Driver" });
    const options = within(screen.getByLabelText(/^driver$/i))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toEqual(["Nobody yet", "Sandbox Driver"]);
    expect(screen.queryByText(/assign one before scheduling/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Schedule inspection" })).toBeEnabled();
  });

  it("posts no nomineeUserId and no dueOn when nothing is chosen, and says nobody holds it yet", async () => {
    stub({
      post: () =>
        respond(
          201,
          task({
            id: "t1",
            responsibleUserId: null,
            responsibleDisplayName: null,
            responsibleVia: null,
            escalated: true,
          }),
        ),
    });
    renderForm();
    await screen.findByRole("option", { name: "Sandbox Driver" });
    await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

    const status = await screen.findByRole("status");
    expect(sentBody(postIndex())).toStrictEqual({});
    expect(status).toHaveTextContent(
      "Inspection scheduled, due 05 Sept 2026. No driver holds it yet.",
    );
  });

  // The date renders through the tenant zone (me()'s Africa/Johannesburg),
  // not the browser's, and the instant straddles the two: 22:30 UTC is the
  // 4th in UTC and the 5th in the tenant's zone, so a UTC render fails here.
  it("posts the nominee and dueOn when chosen, confirms through the tenant zone, and resets", async () => {
    stub({ post: () => respond(201, task({ id: "t1", dueAt: "2026-09-04T22:30:00Z" })) });
    renderForm();
    await screen.findByRole("option", { name: "Sandbox Driver" });
    await userEvent.selectOptions(screen.getByLabelText(/^driver$/i), "d1");
    fireEvent.change(screen.getByLabelText(/^due$/i), { target: { value: "2026-09-10" } });
    await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

    const status = await screen.findByRole("status");
    expect(sentBody(postIndex())).toStrictEqual({ nomineeUserId: "d1", dueOn: "2026-09-10" });
    // en-ZA's short month for September is "Sept", not "Sep" (RigList.test.tsx).
    expect(status).toHaveTextContent("Inspection scheduled for Sandbox Driver, due 05 Sept 2026.");
    expect(screen.getByLabelText(/^driver$/i)).toHaveValue("");
    expect(screen.getByLabelText(/^due$/i)).toHaveValue("");
  });

  it("never prefills the due date", async () => {
    stub();
    renderForm();
    expect(await screen.findByLabelText(/^due$/i)).toHaveValue("");
  });

  // rule 6: the browser never supplies "today"; an omitted dueOn is what
  // makes the server resolve the tenant's own day. Only Date is faked,
  // since faking timers would hang userEvent/TanStack.
  it("takes its today from nowhere, not from the browser clock", async () => {
    vi.useFakeTimers({ now: new Date("2027-03-14"), toFake: ["Date"] });
    try {
      stub({ post: () => respond(201, task({ id: "t1" })) });
      renderForm();
      await screen.findByRole("option", { name: "Sandbox Driver" });
      await userEvent.selectOptions(screen.getByLabelText(/^driver$/i), "d1");
      await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

      await screen.findByRole("status");
      expect(sentBody(postIndex())).toStrictEqual({ nomineeUserId: "d1" });
      // The date input separately: its value is a property, not text, so
      // textContent cannot see a prefilled day.
      expect(screen.getByLabelText(/^due$/i)).toHaveValue("");
      expect(document.body.textContent).not.toContain("2027-03-14");
    } finally {
      vi.useRealTimers();
    }
  });

  it("speaks a TY018 refusal in role=alert", async () => {
    // app.create_inspection_task's own wording, verbatim (000038): a TY
    // message reaches the wire unchanged (ADR-0012), so a paraphrase here
    // would let the screen pass while showing something nobody ever says.
    stub({
      post: () =>
        respond(422, { code: "TY018", message: "a task is due today or later, never in the past" }),
    });
    renderForm();
    await screen.findByRole("option", { name: "Sandbox Driver" });
    await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "a task is due today or later, never in the past",
    );
  });

  it("speaks a TY012 refusal in role=alert", async () => {
    stub({ post: () => respond(422, { code: "TY012", message: "no such user in this fleet" }) });
    renderForm();
    await screen.findByRole("option", { name: "Sandbox Driver" });
    await userEvent.selectOptions(screen.getByLabelText(/^driver$/i), "d1");
    await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("no such user in this fleet");
  });

  it("speaks a retry alert when the driver list fails to load", async () => {
    let fail = true;
    stub({
      drivers: () =>
        fail ? respond(500, { code: "boom", message: "down" }) : respond(200, DRIVERS),
    });
    renderForm();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The driver list could not be loaded.",
    );
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("option", { name: "Sandbox Driver" });
  });
});
