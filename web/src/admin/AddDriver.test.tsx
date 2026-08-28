import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { AddDriver } from "./AddDriver";

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddDriver />
    </QueryClientProvider>,
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

  it("names the rehire case rather than reporting a generic conflict", async () => {
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
    expect(alert).not.toHaveTextContent(/_key|constraint/i);
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
});
