import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { AddDriver } from "./AddDriver";
import { ActorContext } from "../auth/actorContext";
import type { Me } from "../auth/me";

// Capabilities rather than a role name: the screen branches on useCan
// (ADR-0011), so the test names what the screen reads.
function renderScreen(capabilities: string[] = ["ManageUsers", "ManageAssignments"]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const actor: Me = {
    userId: "u0",
    displayName: "Admin",
    role: "ORG_ADMIN",
    capabilities,
    depots: [],
    timezone: "Africa/Johannesburg",
  };
  return render(
    <ActorContext.Provider value={{ actor, settled: true }}>
      <QueryClientProvider client={client}>
        <AddDriver />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CREATED = {
  id: "u1",
  email: "new@example.invalid",
  displayName: "New Driver",
  role: "DRIVER",
  staffNumber: null,
  active: true,
};

async function fillAndSubmit() {
  await userEvent.type(screen.getByLabelText(/email/i), "new@example.invalid");
  await userEvent.type(screen.getByLabelText(/name/i), "New Driver");
  await userEvent.click(screen.getByRole("button", { name: /add user/i }));
}

// RequestInit types body as BodyInit, which includes Blob and FormData;
// String() on those yields "[object Object]" and would assert nothing.
// The client always sends a JSON string, so narrow rather than cast.
function sentBody(call: number): unknown {
  const init = vi.mocked(fetch).mock.calls[call][1];
  if (typeof init?.body !== "string") {
    throw new Error(`call ${call} did not send a string body`);
  }
  return JSON.parse(init.body);
}

describe("adding a driver", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the user and then offers the assignment that makes them able to capture", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(201, CREATED))
      .mockResolvedValueOnce(respond(200, [{ id: "v1", fleetNumber: "H99", registration: null }]));

    renderScreen();
    await fillAndSubmit();

    expect(await screen.findByRole("status")).toHaveTextContent(/New Driver/);
    expect(await screen.findByLabelText(/unit/i)).toBeInTheDocument();
  });

  it("names an active collision as an address already in use", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(409, {
        code: "email_taken",
        message: "a user with that email address already exists in this tenant",
      }),
    );

    renderScreen();
    await fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already exists/i);
  });

  it("names the add-user action on a create refused as forbidden", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(403, { code: "forbidden", message: "no" }));

    renderScreen();
    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission to add a user/i);
  });

  it("names the assign action, not the add-user one, on an assignment refused as forbidden", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(201, CREATED))
      .mockResolvedValueOnce(respond(200, [{ id: "v1", fleetNumber: "H99", registration: null }]))
      .mockResolvedValueOnce(respond(403, { code: "forbidden", message: "no" }));

    renderScreen();
    await fillAndSubmit();
    await screen.findByLabelText(/unit/i);
    await userEvent.click(screen.getByRole("button", { name: /assign/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/permission to assign a unit/i);
    expect(alert).not.toHaveTextContent(/add a user/i);
  });

  it("falls back to a generic message for a create refusal with an unrecognised code", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "unrecognised" }));

    renderScreen();
    await fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/unrecognised/i);
    expect(alert).toHaveTextContent(/add a user/i);
  });

  it("offers no unit picker, and no silent no-op, when there is nothing to assign to", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(201, CREATED))
      .mockResolvedValueOnce(respond(200, []));

    renderScreen();
    await fillAndSubmit();

    expect(await screen.findByText(/no units yet/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/unit/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /assign/i })).not.toBeInTheDocument();
  });

  it("clears the create form once a user has been added", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(201, CREATED))
      .mockResolvedValueOnce(respond(200, [{ id: "v1", fleetNumber: "H99", registration: null }]));

    renderScreen();
    await fillAndSubmit();

    await screen.findByRole("status");
    expect(screen.getByLabelText(/email/i)).toHaveValue("");
    expect(screen.getByLabelText(/name/i)).toHaveValue("");
  });

  it("records the assignment against the unit chosen", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(201, CREATED))
      .mockResolvedValueOnce(respond(200, [{ id: "v1", fleetNumber: "H99", registration: null }]))
      .mockResolvedValueOnce(
        respond(201, { id: "a1", vehicleId: "v1", userId: "u1", fromDate: "2026-08-28" }),
      );

    renderScreen();
    await fillAndSubmit();
    await screen.findByLabelText(/unit/i);
    await userEvent.selectOptions(screen.getByLabelText(/unit/i), "v1");
    await userEvent.click(screen.getByRole("button", { name: /assign/i }));

    expect(await screen.findByText(/assigned to H99/i)).toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls[2][0]).toBe("/api/vehicles/v1/drivers");
  });

  it("offers only DRIVER to an actor holding InviteDriver alone", () => {
    renderScreen(["ManageAssignments", "InviteDriver"]);

    const roles = screen.getAllByRole("option", { name: /driver|controller|admin|technician/i });
    expect(roles).toHaveLength(1);
    expect(screen.getByRole("option", { name: "Driver" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Organisation admin" })).not.toBeInTheDocument();
  });

  it("offers every tenant role to an actor holding ManageUsers", () => {
    renderScreen(["ManageUsers", "ManageAssignments"]);

    expect(screen.getByRole("option", { name: "Organisation admin" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Driver" })).toBeInTheDocument();
  });

  // The refusal has to become an offer, or the admin's only reading is "pick
  // another address" — which for a rehire is wrong and creates a second person.
  it("offers reactivation when the email belongs to a deactivated user", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        respond(409, {
          code: "email_inactive",
          message:
            "a user with this email address was deactivated; reactivate them instead of adding a new one",
        }),
      )
      .mockResolvedValueOnce(respond(201, CREATED))
      .mockResolvedValueOnce(respond(200, []));

    renderScreen();
    await fillAndSubmit();

    const again = await screen.findByRole("button", { name: /reactivate/i });
    await userEvent.click(again);

    await screen.findByRole("status");
    expect(sentBody(1)).toMatchObject({
      email: "new@example.invalid",
      reactivate: true,
    });
  });

  // A double-click here reads as "Thandi was added" followed immediately by
  // "already in use" for the same person — on the one screen meant to stop a
  // rehire becoming a second one.
  it("disables the reactivate button while the reactivate request is in flight, then completes", async () => {
    // Hold the reactivate request open so "in flight" is a state the test can
    // inspect rather than race, then release it so the component does not
    // tear down mid-request.
    let release!: (value: Response) => void;
    const inFlight = new Promise<Response>((resolve) => {
      release = resolve;
    });

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        respond(409, {
          code: "email_inactive",
          message: "a user with this email address was deactivated",
        }),
      )
      .mockReturnValueOnce(inFlight)
      .mockResolvedValueOnce(respond(200, []));

    renderScreen();
    await fillAndSubmit();

    const again = await screen.findByRole("button", { name: /reactivate/i });
    await userEvent.click(again);

    expect(again).toBeDisabled();
    // Tanstack Query clears create.error the moment this second mutation
    // starts, so this alert must still be reading state captured at the
    // first refusal rather than re-deriving from the (now cleared) error —
    // otherwise a live region announces the generic fallback sentence over a
    // request that is in fact succeeding (D10).
    expect(screen.getByRole("alert")).toHaveTextContent(/deactivated/i);

    release(respond(201, CREATED));

    expect(await screen.findByRole("status")).toHaveTextContent(/New Driver/);
    expect(screen.queryByRole("button", { name: /reactivate/i })).not.toBeInTheDocument();
  });

  // The browser's calendar day is the admin's, not the tenant's. Sending none
  // lets the server compute it where the tenant's zone lives (TYRE-89).
  it("sends no date with an assignment", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(201, CREATED))
      .mockResolvedValueOnce(respond(200, [{ id: "v1", fleetNumber: "H99", registration: null }]))
      .mockResolvedValueOnce(
        respond(201, { id: "a1", vehicleId: "v1", userId: "u1", fromDate: "2026-08-28" }),
      );

    renderScreen();
    await fillAndSubmit();
    await screen.findByLabelText(/unit/i);
    await userEvent.selectOptions(screen.getByLabelText(/unit/i), "v1");
    await userEvent.click(screen.getByRole("button", { name: /assign/i }));
    await screen.findByText(/assigned to H99/i);

    expect(sentBody(2)).not.toHaveProperty("fromDate");
  });
});
