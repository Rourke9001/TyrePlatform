import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { ScheduleInspectionForm } from "./ScheduleInspectionForm";
import { ActorContext } from "../../auth/actorContext";
import type { UnitDriver, UnitTask } from "../../api/tasks";
import { me, respond, sentBody, testQueryClient, unit } from "../../test/fixtures";

const UNIT = unit({ id: "u9", fleetNumber: "TRAILER-9" });

function driver(overrides: Partial<UnitDriver> & { userId: string }): UnitDriver {
  return {
    displayName: "Sandbox Driver",
    staffNumber: null,
    viaVehicleId: "u9",
    viaFleetNumber: "TRAILER-9",
    ...overrides,
  };
}

function task(overrides: Partial<UnitTask> & { id: string }): UnitTask {
  return {
    vehicleId: "u9",
    fleetNumber: "TRAILER-9",
    dueAt: "2026-09-04T22:30:00Z",
    state: "OPEN",
    overdue: false,
    assignedUserId: "d1",
    assignedDisplayName: "Sandbox Driver",
    ...overrides,
  };
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

  it("names a driver plainly for this unit, and with its via unit for another", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(200, [
        driver({
          userId: "d1",
          viaVehicleId: "u9",
          viaFleetNumber: "TRAILER-9",
        }),
        driver({
          userId: "d2",
          viaVehicleId: "u1",
          viaFleetNumber: "HORSE-1",
        }),
      ]),
    );
    renderForm();

    await screen.findByRole("option", { name: "Sandbox Driver (via HORSE-1)" });
    const select = screen.getByLabelText(/^driver$/i);
    const options = within(select)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).toContain("Sandbox Driver");
    expect(options).toContain("Sandbox Driver (via HORSE-1)");
  });

  it("shows an invitation instead of the select when the unit has no driver", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, []));
    renderForm();

    expect(
      await screen.findByText(
        "No driver is assigned to this unit. Assign one before scheduling an inspection.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("disables Schedule inspection until a driver is chosen", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
    renderForm();
    await screen.findByRole("option", { name: "Sandbox Driver" });

    expect(screen.getByRole("button", { name: "Schedule inspection" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText(/^driver$/i), "d1");
    expect(screen.getByRole("button", { name: "Schedule inspection" })).toBeEnabled();
  });

  it("posts the chosen driver without dueOn when the date is left blank", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
    renderForm();
    await screen.findByRole("option", { name: "Sandbox Driver" });
    await userEvent.selectOptions(screen.getByLabelText(/^driver$/i), "d1");

    vi.mocked(fetch).mockResolvedValueOnce(respond(201, task({ id: "t1" })));
    await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

    await screen.findByRole("status");
    expect(sentBody(1)).toStrictEqual({ assigneeUserId: "d1" });
  });

  it("posts dueOn when a date is chosen", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
    renderForm();
    await screen.findByRole("option", { name: "Sandbox Driver" });
    await userEvent.selectOptions(screen.getByLabelText(/^driver$/i), "d1");
    fireEvent.change(screen.getByLabelText(/^due$/i), { target: { value: "2026-09-10" } });

    vi.mocked(fetch).mockResolvedValueOnce(respond(201, task({ id: "t1" })));
    await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

    await screen.findByRole("status");
    expect(sentBody(1)).toStrictEqual({ assigneeUserId: "d1", dueOn: "2026-09-10" });
  });

  it("never prefills the due date", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
    renderForm();
    expect(await screen.findByLabelText(/^due$/i)).toHaveValue("");
  });

  // rule 6: the browser never supplies "today". With the clock pinned to a
  // day nothing else names, that day must appear neither on the screen nor
  // in the body — an omitted dueOn is what makes the server resolve the
  // tenant's own day. Only Date is faked: faking the timers would hang
  // userEvent and TanStack's own scheduling.
  it("takes its today from nowhere, not from the browser clock", async () => {
    vi.useFakeTimers({ now: new Date("2027-03-14"), toFake: ["Date"] });
    try {
      vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
      renderForm();
      await screen.findByRole("option", { name: "Sandbox Driver" });
      await userEvent.selectOptions(screen.getByLabelText(/^driver$/i), "d1");

      vi.mocked(fetch).mockResolvedValueOnce(respond(201, task({ id: "t1" })));
      await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

      await screen.findByRole("status");
      expect(sentBody(1)).toStrictEqual({ assigneeUserId: "d1" });
      // The date input separately: its value is a property, not text, so
      // textContent cannot see a prefilled day.
      expect(screen.getByLabelText(/^due$/i)).toHaveValue("");
      expect(document.body.textContent).not.toContain("2027-03-14");
    } finally {
      vi.useRealTimers();
    }
  });

  // The date renders through the tenant zone (me()'s Africa/Johannesburg),
  // not the browser's, and the instant straddles the two: 22:30 UTC is the
  // 4th in UTC and the 5th in the tenant's zone, so a UTC render fails here.
  it("confirms the scheduled inspection through the tenant zone, and resets the driver select", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
    renderForm();
    await screen.findByRole("option", { name: "Sandbox Driver" });
    await userEvent.selectOptions(screen.getByLabelText(/^driver$/i), "d1");
    fireEvent.change(screen.getByLabelText(/^due$/i), { target: { value: "2026-09-10" } });

    vi.mocked(fetch).mockResolvedValueOnce(
      respond(
        201,
        task({ id: "t1", dueAt: "2026-09-04T22:30:00Z", assignedDisplayName: "Sandbox Driver" }),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

    const status = await screen.findByRole("status");
    // en-ZA's short month for September is "Sept", not "Sep" (RigList.test.tsx).
    expect(status).toHaveTextContent("Inspection scheduled for Sandbox Driver, due 05 Sept 2026.");
    expect(screen.getByLabelText(/^driver$/i)).toHaveValue("");
    expect(screen.getByLabelText(/^due$/i)).toHaveValue("");
  });

  it("speaks a TY018 refusal in role=alert", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
    renderForm();
    await screen.findByRole("option", { name: "Sandbox Driver" });
    await userEvent.selectOptions(screen.getByLabelText(/^driver$/i), "d1");

    // app.create_inspection_task's own wording, verbatim (000038): a TY
    // message reaches the wire unchanged (ADR-0012), so a paraphrase here
    // would let the screen pass while showing something nobody ever says.
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(422, { code: "TY018", message: "a task is due today or later, never in the past" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "a task is due today or later, never in the past",
    );
  });

  it("speaks a TY012 refusal in role=alert", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
    renderForm();
    await screen.findByRole("option", { name: "Sandbox Driver" });
    await userEvent.selectOptions(screen.getByLabelText(/^driver$/i), "d1");

    vi.mocked(fetch).mockResolvedValueOnce(
      respond(422, { code: "TY012", message: "no such user in this fleet" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Schedule inspection" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("no such user in this fleet");
  });

  it("speaks a retry alert when the driver list fails to load", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "down" }));
    renderForm();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The driver list could not be loaded.",
    );

    vi.mocked(fetch).mockResolvedValueOnce(respond(200, [driver({ userId: "d1" })]));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("option", { name: "Sandbox Driver" });
  });
});
