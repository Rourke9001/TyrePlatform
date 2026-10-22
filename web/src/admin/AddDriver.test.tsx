import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { AddDriver } from "./AddDriver";
import { renderWithActor, requestedUrl, respond, sentBody } from "../test/fixtures";

// Capabilities rather than a role name: the screen branches on useCan
// (ADR-0011), so the test names what the screen reads.
function renderScreen(capabilities: string[] = ["ManageUsers", "ManageAssignments"]) {
  return renderWithActor(<AddDriver />, { capabilities });
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

describe("adding a driver", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A trip or a nomination is how a driver reaches capture (FR-AUT-005 as
  // amended), so the create is the whole screen: no unit is read or written.
  it("creates the user and stops there, with no assign step", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(201, CREATED));

    renderScreen();
    await fillAndSubmit();

    expect(await screen.findByRole("status")).toHaveTextContent(/New Driver was added/);
    expect(screen.queryByRole("heading", { name: "Assign to a unit" })).toBeNull();
    expect(screen.queryByLabelText(/^unit$/i)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    const urls = vi.mocked(fetch).mock.calls.map((c) => requestedUrl(c[0]));
    expect(urls.some((u) => u.endsWith("/drivers"))).toBe(false);
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

  // TYRE-83: the server names this refusal specifically (a rehire's staff
  // number colliding with a legitimate reuse). Without it in speakable, the
  // admin sees only the generic fallback.
  it("shows the server's message for a staff-number collision, not the generic fallback", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      respond(409, {
        code: "staff_number_taken",
        message:
          "another active user already has that staff number; give this one a different number",
      }),
    );

    renderScreen();
    await fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already has that staff number/i);
    expect(alert).not.toHaveTextContent(/could not add a user/i);
  });

  it("names the add-user action on a create refused as forbidden", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(403, { code: "forbidden", message: "no" }));

    renderScreen();
    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission to add a user/i);
  });

  it("falls back to a generic message for a create refusal with an unrecognised code", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(500, { code: "boom", message: "unrecognised" }));

    renderScreen();
    await fillAndSubmit();

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/unrecognised/i);
    expect(alert).toHaveTextContent(/add a user/i);
  });

  it("clears the create form once a user has been added", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(201, CREATED));

    renderScreen();
    await fillAndSubmit();

    await screen.findByRole("status");
    expect(screen.getByLabelText(/email/i)).toHaveValue("");
    expect(screen.getByLabelText(/name/i)).toHaveValue("");
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
  // another address", which for a rehire is wrong and creates a second person.
  it("offers reactivation when the email belongs to a deactivated user", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        respond(409, {
          code: "email_inactive",
          message:
            "a user with this email address was deactivated; reactivate them instead of adding a new one",
        }),
      )
      // 200, not 201: a reactivate is an in-place update (TYRE-95).
      .mockResolvedValueOnce(respond(200, CREATED))
      .mockResolvedValueOnce(respond(200, []));

    renderScreen();
    await fillAndSubmit();

    const again = await screen.findByRole("button", { name: /reactivate/i });
    await userEvent.click(again);

    expect(await screen.findByRole("status")).toHaveTextContent(/was restored/);
    expect(sentBody(1)).toMatchObject({
      email: "new@example.invalid",
      reactivate: true,
    });
  });

  // A double-click here reads as "Thandi was added" followed immediately by
  // "already in use" for the same person, on the one screen meant to stop a
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
    // See AddDriver.tsx's D10 capture of create.error before Reactivate
    // clears it.
    expect(screen.getByRole("alert")).toHaveTextContent(/deactivated/i);

    // The reactivate path answers 200 (TYRE-95).
    release(respond(200, CREATED));

    // "restored", not "added": the admin brought back someone with history,
    // and the sentence must not claim a stranger joined (TYRE-95).
    expect(await screen.findByRole("status")).toHaveTextContent(/New Driver was restored/);
    expect(screen.queryByRole("button", { name: /reactivate/i })).not.toBeInTheDocument();
  });
});
