import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { AddUnit } from "./AddUnit";

function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AddUnit />
    </QueryClientProvider>,
  );
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CONFIGS = [{ id: "c1", code: "HORSE_6X4", name: "Horse 6x4", version: 1, axleCount: 3 }];

describe("adding a unit", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the unit and confirms it by fleet number", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, CONFIGS))
      .mockResolvedValueOnce(respond(201, { id: "v1", fleetNumber: "H99", registration: null }));

    renderScreen();
    await screen.findByRole("option", { name: /Horse 6x4/ });
    await userEvent.type(screen.getByLabelText(/fleet number/i), "H99");
    await userEvent.selectOptions(screen.getByLabelText(/unit kind/i), "HORSE");
    await userEvent.click(screen.getByRole("button", { name: /add unit/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/H99/);
  });

  it("says which conflict happened when the fleet number is taken", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, CONFIGS))
      .mockResolvedValueOnce(
        respond(409, {
          code: "fleet_number_taken",
          message: "a unit with that fleet number already exists",
        }),
      );

    renderScreen();
    await screen.findByRole("option", { name: /Horse 6x4/ });
    await userEvent.type(screen.getByLabelText(/fleet number/i), "H1");
    await userEvent.selectOptions(screen.getByLabelText(/unit kind/i), "HORSE");
    await userEvent.click(screen.getByRole("button", { name: /add unit/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/fleet number/i);
  });

  it("shows a validation refusal's own message", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, CONFIGS))
      .mockResolvedValueOnce(
        respond(422, { code: "invalid_submission", message: "fleetNumber is too long" }),
      );

    renderScreen();
    await screen.findByRole("option", { name: /Horse 6x4/ });
    await userEvent.type(screen.getByLabelText(/fleet number/i), "H1");
    await userEvent.selectOptions(screen.getByLabelText(/unit kind/i), "HORSE");
    await userEvent.click(screen.getByRole("button", { name: /add unit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/too long/i);
  });

  it("names the permission problem when the create itself is refused as forbidden", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, CONFIGS))
      .mockResolvedValueOnce(respond(403, { code: "forbidden", message: "no" }));

    renderScreen();
    await screen.findByRole("option", { name: /Horse 6x4/ });
    await userEvent.type(screen.getByLabelText(/fleet number/i), "H1");
    await userEvent.selectOptions(screen.getByLabelText(/unit kind/i), "HORSE");
    await userEvent.click(screen.getByRole("button", { name: /add unit/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/permission to add a unit/i);
  });

  it("falls back to a generic message for a create refusal with an unrecognised code", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(respond(200, CONFIGS))
      .mockResolvedValueOnce(respond(500, { code: "boom", message: "unrecognised" }));

    renderScreen();
    await screen.findByRole("option", { name: /Horse 6x4/ });
    await userEvent.type(screen.getByLabelText(/fleet number/i), "H1");
    await userEvent.selectOptions(screen.getByLabelText(/unit kind/i), "HORSE");
    await userEvent.click(screen.getByRole("button", { name: /add unit/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent(/unrecognised/i);
    expect(alert).toHaveTextContent(/could not be added/i);
  });

  it("reports a refused library rather than rendering an empty picker", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(respond(403, { code: "forbidden", message: "no" }));
    renderScreen();
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
  });
});
