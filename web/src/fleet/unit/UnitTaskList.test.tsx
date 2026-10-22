import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { UnitTaskList } from "./UnitTaskList";
import { ActorContext } from "../../auth/actorContext";
import type { UnitTask } from "../../api/tasks";
import type { Driver } from "../../api/trips";
import { me, requestedUrl, respond, sentBody, testQueryClient } from "../../test/fixtures";

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
    responsibleVia: "TRIP",
    ...overrides,
  };
}

const DRIVERS: Driver[] = [{ userId: "d2", displayName: "Sipho", staffNumber: null, onTrip: null }];

// Every read and write by URL, so the order the list and the pickers ask in
// cannot decide a test.
function stub(tasks: () => unknown, nominate?: () => Response) {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = requestedUrl(input);
    if (url === "/api/vehicles/u9/inspection-tasks") return Promise.resolve(respond(200, tasks()));
    if (url === "/api/drivers") return Promise.resolve(respond(200, DRIVERS));
    if (url.startsWith("/api/inspection-tasks/") && init?.method === "POST" && nominate) {
      return Promise.resolve(nominate());
    }
    throw new Error(`unstubbed ${url}`);
  });
}

function renderList(capabilities: string[] = ["ViewFleet"]) {
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities }), settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <UnitTaskList unitId="u9" />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

async function rowOf(text: string): Promise<HTMLElement> {
  const row = (await screen.findByText(text)).closest("tr");
  if (!row) throw new Error("row not found");
  return row;
}

describe("the unit's open inspections", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // rule 6: the fixture straddles a day boundary between UTC and
  // Africa/Johannesburg; the fractional second is the wire's own shape
  // (000038) and must not move the day.
  it("lists a task's driver, tenant-zone due date and status", async () => {
    stub(() => [task({ id: "t1", dueAt: "2026-09-04T22:30:00.999999Z" })]);
    renderList();

    expect(await screen.findByRole("heading", { name: "Open inspections" })).toBeInTheDocument();
    const row = await rowOf("Sandbox Driver");
    // en-ZA's short month for September is "Sept", not "Sep" (RigList.test.tsx).
    expect(within(row).getByText("05 Sept 2026")).toBeInTheDocument();
    expect(within(row).getByText("Open")).toBeInTheDocument();
  });

  it("marks a nominee as nominated, through the task or through the motive", async () => {
    stub(() => [
      task({ id: "t1", responsibleVia: "NOMINATION", responsibleDisplayName: "Sipho" }),
      task({ id: "t2", responsibleVia: "MOTIVE_NOMINATION", responsibleDisplayName: "Thandi" }),
    ]);
    renderList();

    expect(await screen.findByText("Sipho (nominated)")).toBeInTheDocument();
    expect(screen.getByText("Thandi (nominated)")).toBeInTheDocument();
  });

  // NFR-USE-009: escalated and overdue are words, never colour alone.
  it("reads No driver, and each status in words", async () => {
    stub(() => [
      task({
        id: "t1",
        escalated: true,
        overdue: true,
        responsibleUserId: null,
        responsibleDisplayName: null,
        responsibleVia: null,
        dueAt: "2025-01-01T08:00:00Z",
      }),
      task({
        id: "t2",
        escalated: true,
        responsibleUserId: null,
        responsibleDisplayName: null,
        responsibleVia: null,
        dueAt: "2099-01-01T08:00:00Z",
      }),
      task({ id: "t3", overdue: true, dueAt: "2025-02-01T08:00:00Z" }),
    ]);
    renderList();

    const rows = await screen.findAllByRole("row");
    const cells = rows
      .slice(1)
      .map((r) => Array.from(r.querySelectorAll("th, td")).map((c) => c.textContent));
    expect(cells).toEqual([
      ["No driver", "01 Jan 2025", "Escalated, overdue"],
      ["No driver", "01 Jan 2099", "Escalated"],
      ["Sandbox Driver", "01 Feb 2025", "Overdue"],
    ]);
  });

  it("offers no nominate control without ManageAssignments", async () => {
    stub(() => [
      task({
        id: "t1",
        responsibleVia: null,
        responsibleUserId: null,
        responsibleDisplayName: null,
        escalated: true,
      }),
    ]);
    renderList(["ViewFleet"]);

    await rowOf("No driver");
    expect(screen.queryByRole("button", { name: /nominate/i })).toBeNull();
  });

  it("offers no nominate control on a row a trip holds", async () => {
    stub(() => [task({ id: "t1" })]);
    renderList(["ViewFleet", "ManageAssignments"]);

    await rowOf("Sandbox Driver");
    expect(screen.queryByRole("button", { name: /nominate/i })).toBeNull();
  });

  it("nominates a driver for a row no trip holds, and reads the list again", async () => {
    let nominated = false;
    stub(
      () =>
        nominated
          ? [
              task({
                id: "t1",
                responsibleVia: "NOMINATION",
                responsibleUserId: "d2",
                responsibleDisplayName: "Sipho",
              }),
            ]
          : [
              task({
                id: "t1",
                responsibleVia: null,
                responsibleUserId: null,
                responsibleDisplayName: null,
                escalated: true,
              }),
            ],
      () => {
        nominated = true;
        return respond(
          201,
          task({
            id: "t1",
            responsibleVia: "NOMINATION",
            responsibleUserId: "d2",
            responsibleDisplayName: "Sipho",
          }),
        );
      },
    );
    renderList(["ViewFleet", "ManageAssignments"]);

    const row = await rowOf("No driver");
    await within(row).findByRole("option", { name: "Sipho" });
    await userEvent.selectOptions(within(row).getByRole("combobox"), "d2");
    await userEvent.click(within(row).getByRole("button", { name: "Nominate" }));

    expect(await screen.findByText("Sipho (nominated)")).toBeInTheDocument();
    const post = vi
      .mocked(fetch)
      .mock.calls.findIndex((c) => requestedUrl(c[0]) === "/api/inspection-tasks/t1/nominations");
    expect(post).toBeGreaterThanOrEqual(0);
    expect(sentBody(post)).toEqual({ userId: "d2" });
  });

  it("speaks a TY018 refusal of a nomination", async () => {
    stub(
      () => [
        task({
          id: "t1",
          responsibleVia: null,
          responsibleUserId: null,
          responsibleDisplayName: null,
          escalated: true,
        }),
      ],
      () =>
        respond(422, {
          code: "TY018",
          message: "HORSE-1 is on Melusi's trip; the inspection already goes to them",
        }),
    );
    renderList(["ViewFleet", "ManageAssignments"]);

    const row = await rowOf("No driver");
    await within(row).findByRole("option", { name: "Sipho" });
    await userEvent.selectOptions(within(row).getByRole("combobox"), "d2");
    await userEvent.click(within(row).getByRole("button", { name: "Nominate" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "HORSE-1 is on Melusi's trip; the inspection already goes to them",
    );
  });

  it("shows the empty state", async () => {
    stub(() => []);
    renderList();

    expect(await screen.findByText("No open inspections.")).toBeInTheDocument();
  });

  it("speaks a retry alert when the list fails to load", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "down" }));
    renderList();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The open inspections could not be loaded.",
    );

    stub(() => [task({ id: "t1" })]);
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Sandbox Driver");
  });
});
