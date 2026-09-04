import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { UnitTaskList } from "./UnitTaskList";
import { ActorContext } from "../../auth/actorContext";
import type { UnitTask } from "../../api/tasks";
import { me, respond, testQueryClient } from "../../test/fixtures";

function task(overrides: Partial<UnitTask> & { id: string }): UnitTask {
  return {
    vehicleId: "u9",
    fleetNumber: "TRAILER-9",
    dueAt: "2026-09-04T21:59:59Z",
    state: "OPEN",
    overdue: false,
    assignedUserId: "d1",
    assignedDisplayName: "Sandbox Driver",
    ...overrides,
  };
}

function renderList() {
  return render(
    <ActorContext.Provider value={{ actor: me({ capabilities: ["ViewFleet"] }), settled: true }}>
      <QueryClientProvider client={testQueryClient()}>
        <UnitTaskList unitId="u9" />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

describe("the unit's open inspections", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // rule 6: the instant renders in the tenant's own zone, and a fractional
  // second on the wire (2026-09-04T21:59:59.999999Z) renders the same day.
  it("lists a task's driver, tenant-zone due date and status", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [task({ id: "t1", dueAt: "2026-09-04T21:59:59.999999Z" })]),
    );
    renderList();

    expect(await screen.findByRole("heading", { name: "Open inspections" })).toBeInTheDocument();
    const row = (await screen.findByText("Sandbox Driver")).closest("tr");
    if (!row) throw new Error("row not found");
    // en-ZA's short month for September is "Sept", not "Sep" (RigList.test.tsx).
    expect(within(row).getByText("04 Sept 2026")).toBeInTheDocument();
    expect(within(row).getByText("Open")).toBeInTheDocument();
  });

  it("reads Escalated for an escalated task", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [task({ id: "t1", state: "ESCALATED" })]));
    renderList();

    const row = (await screen.findByText("Sandbox Driver")).closest("tr");
    if (!row) throw new Error("row not found");
    expect(within(row).getByText("Escalated")).toBeInTheDocument();
  });

  // NFR-USE-009: overdue is a word, not only a colour.
  it("names an overdue row Overdue rather than colour alone", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [task({ id: "t1", state: "ESCALATED", overdue: true })]),
    );
    renderList();

    const row = (await screen.findByText("Sandbox Driver")).closest("tr");
    if (!row) throw new Error("row not found");
    expect(within(row).getByText("Overdue")).toBeInTheDocument();
  });

  it("reads Unassigned for an escalated task with no assignee", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [
        task({ id: "t1", state: "ESCALATED", assignedUserId: null, assignedDisplayName: null }),
      ]),
    );
    renderList();

    expect(await screen.findByText("Unassigned")).toBeInTheDocument();
  });

  it("shows the empty state", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, []));
    renderList();

    expect(await screen.findByText("No open inspections.")).toBeInTheDocument();
  });

  it("speaks a retry alert when the list fails to load", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "down" }));
    renderList();

    expect(await screen.findByRole("alert")).toBeInTheDocument();

    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [task({ id: "t1" })]));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText("Sandbox Driver");
  });
});
