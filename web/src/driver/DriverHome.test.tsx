import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithActor, requestedUrl, respond } from "../test/fixtures";
import { formatTenantDate } from "../time/tenantTime";
import { DriverHome } from "./DriverHome";

const DUE = "2026-10-23T06:00:00Z";
const DUE_TEXT = formatTenantDate(DUE, "Africa/Johannesburg");

interface Task {
  id: string;
  vehicleId: string;
  fleetNumber: string;
  dueAt: string;
  state: string;
  overdue: boolean;
  captureVehicleId?: string;
}

function task(overrides: Partial<Task> & Pick<Task, "id" | "vehicleId" | "fleetNumber">): Task {
  return { dueAt: DUE, state: "OPEN", overdue: false, ...overrides };
}

const H1 = { vehicleId: "h1", fleetNumber: "H1" };
const T1 = { vehicleId: "t1", fleetNumber: "T1" };
const T2 = { vehicleId: "t2", fleetNumber: "T2" };

function onTrip(trailers = [T1, T2]) {
  return {
    trip: {
      id: "trip1",
      motive: H1,
      driver: { userId: "u0", displayName: "Test" },
      startedAt: "2026-10-22T05:00:00Z",
      startedBy: null,
      endedAt: null,
      trailers,
    },
  };
}

type Answer = { status: number; body: unknown } | "pending";

// Routed by URL, so neither query's order decides the answer.
function stub(tasks: Answer, trip: Answer) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      const answer = url === "/api/my/tasks" ? tasks : url === "/api/my/trip" ? trip : null;
      if (answer === null) throw new Error(`unstubbed ${url}`);
      if (answer === "pending") return new Promise<Response>(() => undefined);
      return Promise.resolve(respond(answer.status, answer.body));
    }),
  );
}

const ok = (body: unknown): Answer => ({ status: 200, body });

function renderHome() {
  return renderWithActor(<DriverHome />, { withRouter: true });
}

function hrefOf(name: string | RegExp): string | null {
  return screen.getByRole("link", { name }).getAttribute("href");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the driver's home", () => {
  // The trip's units in rig order, each with its due links; a
  // unit with nothing due is named, not linked.
  it("lists the truck then each trailer of the trip, with their due inspections", async () => {
    stub(
      ok([
        task({ id: "k2", vehicleId: "t2", fleetNumber: "T2", overdue: true }),
        task({ id: "k1", vehicleId: "h1", fleetNumber: "H1", captureVehicleId: "h1" }),
      ]),
      ok(onTrip()),
    );
    renderHome();

    const section = await screen.findByRole("region", { name: "Your trip" });
    const items = within(section).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      `H1, due ${DUE_TEXT}`,
      "T1",
      `T2, due ${DUE_TEXT} (overdue)`,
    ]);
    expect(within(items[0]).getByRole("link").getAttribute("href")).toBe("/capture/h1?taskId=k1");
    expect(within(items[1]).queryByRole("link")).toBeNull();
    expect(screen.queryByText("Nothing due.")).toBeNull();
  });

  it("says nothing is due once for a trip with nothing due", async () => {
    stub(ok([]), ok(onTrip()));
    renderHome();

    await screen.findByRole("region", { name: "Your trip" });
    expect(screen.getAllByText("Nothing due.")).toHaveLength(1);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("lists a nominee's units under their own heading", async () => {
    stub(
      ok([task({ id: "k9", vehicleId: "x9", fleetNumber: "X9", captureVehicleId: "x9" })]),
      ok({ trip: null }),
    );
    renderHome();

    const section = await screen.findByRole("region", { name: "Nominated inspections" });
    expect(within(section).getByRole("link").getAttribute("href")).toBe("/capture/x9?taskId=k9");
    expect(screen.queryByRole("region", { name: "Your trip" })).toBeNull();
    expect(screen.queryByText("You are not on a trip.")).toBeNull();
  });

  // A solo trailer capture would lose the rig, so a coupled
  // trailer's task opens its motive's capture, naming the trailer's task.
  it("links each task to the unit it is captured through", async () => {
    stub(
      ok([
        task({ id: "kt1", vehicleId: "t1", fleetNumber: "T1", captureVehicleId: "h1" }),
        task({ id: "kn", vehicleId: "n1", fleetNumber: "N1", captureVehicleId: "m1" }),
        task({ id: "ks", vehicleId: "s1", fleetNumber: "S1", captureVehicleId: "s1" }),
        task({ id: "ko", vehicleId: "o1", fleetNumber: "O1" }),
      ]),
      ok(onTrip([T1])),
    );
    renderHome();

    await screen.findByRole("region", { name: "Nominated inspections" });
    expect(hrefOf(/^T1,/)).toBe("/capture/h1?taskId=kt1");
    expect(hrefOf(/^N1,/)).toBe("/capture/m1?taskId=kn");
    expect(hrefOf(/^S1,/)).toBe("/capture/s1?taskId=ks");
    // An API older than the web sends no captureVehicleId.
    expect(hrefOf(/^O1,/)).toBe("/capture/o1?taskId=ko");
  });

  it("shows both sections at once and each task once", async () => {
    stub(
      ok([
        task({ id: "k1", vehicleId: "h1", fleetNumber: "H1", captureVehicleId: "h1" }),
        task({ id: "k9", vehicleId: "x9", fleetNumber: "X9", captureVehicleId: "x9" }),
      ]),
      ok(onTrip([])),
    );
    renderHome();

    const trip = await screen.findByRole("region", { name: "Your trip" });
    const nominated = screen.getByRole("region", { name: "Nominated inspections" });
    expect(
      within(trip)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/capture/h1?taskId=k1"]);
    expect(
      within(nominated)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/capture/x9?taskId=k9"]);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("says the driver is not on a trip when there is no trip and no task", async () => {
    stub(ok([]), ok({ trip: null }));
    renderHome();

    expect(await screen.findByText("You are not on a trip.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The one tap to a task is never held behind the second read.
  it("links the tasks as soon as they load, while the trip is still loading", async () => {
    stub(ok([task({ id: "k1", vehicleId: "h1", fleetNumber: "H1" })]), "pending");
    renderHome();

    expect(await screen.findByRole("link", { name: /^H1,/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My inspections" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Your trip" })).toBeNull();
  });

  it("keeps the task links when the trip cannot load, and says so", async () => {
    stub(ok([task({ id: "k1", vehicleId: "h1", fleetNumber: "H1" })]), {
      status: 500,
      body: {},
    });
    renderHome();

    expect(await screen.findByRole("alert")).toHaveTextContent(/trip/i);
    expect(hrefOf(/^H1,/)).toBe("/capture/h1?taskId=k1");
    expect(screen.getByRole("heading", { name: "My inspections" })).toBeInTheDocument();
  });

  it("shows the trip when the tasks cannot load, and says so", async () => {
    stub({ status: 500, body: {} }, ok(onTrip()));
    renderHome();

    expect(await screen.findByRole("alert")).toHaveTextContent(/inspections/i);
    const section = await screen.findByRole("region", { name: "Your trip" });
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["H1", "T1", "T2"]);
    // Nothing is known to be due, so nothing says so.
    expect(screen.queryByText("Nothing due.")).toBeNull();
    expect(screen.getByRole("heading", { name: "My inspections" })).toBeInTheDocument();
  });

  it("names the heading while both reads are pending", async () => {
    stub("pending", "pending");
    renderHome();

    expect(screen.getByRole("heading", { name: "My inspections" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Loading…")).toBeInTheDocument());
  });
});
