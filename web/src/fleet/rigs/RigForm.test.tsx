import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { RigForm } from "./RigForm";
import { ActorContext } from "../../auth/actorContext";
import type { Rig } from "../../api/combinations";
import type { Vehicle } from "../../api/vehicles";
import { me, respond, sentBody, testQueryClient } from "../../test/fixtures";

function vehicle(overrides: Partial<Vehicle> & { id: string; fleetNumber: string }): Vehicle {
  return {
    registration: null,
    unitKind: "HORSE",
    status: "ACTIVE",
    ...overrides,
  };
}

function rig(overrides: Partial<Rig> & { id: string }): Rig {
  return {
    motiveVehicleId: "u1",
    motiveFleetNumber: "HORSE-1",
    effectiveFrom: "2026-08-01T06:00:00Z",
    effectiveTo: null,
    members: [
      { vehicleId: "u1", fleetNumber: "HORSE-1", sequence: 1, descriptor: null, unitKind: "HORSE" },
    ],
    ...overrides,
  };
}

function renderForm() {
  return render(
    <ActorContext.Provider
      value={{ actor: me({ capabilities: ["ViewFleet", "ManageAssignments"] }), settled: true }}
    >
      <QueryClientProvider client={testQueryClient()}>
        <RigForm />
      </QueryClientProvider>
    </ActorContext.Provider>,
  );
}

// The two reads RigForm makes on mount, in the order it issues them
// (rigsKey before vehiclesKey, matching D5's own useQuery order).
function mockLists(rigs: Rig[], vehicles: Vehicle[]) {
  vi.mocked(fetch)
    .mockResolvedValueOnce(respond(200, rigs))
    .mockResolvedValueOnce(respond(200, vehicles));
}

describe("setting a rig", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers only HORSE/RIGID/LIGHT units not already coupled as motive, and only free trailers as towed", async () => {
    mockLists(
      [
        rig({
          id: "r1",
          motiveVehicleId: "u9",
          motiveFleetNumber: "HORSE-9",
          members: [
            {
              vehicleId: "u9",
              fleetNumber: "HORSE-9",
              sequence: 1,
              descriptor: null,
              unitKind: "HORSE",
            },
            {
              vehicleId: "u5",
              fleetNumber: "LINK-5",
              sequence: 2,
              descriptor: null,
              unitKind: "TRAILER",
            },
          ],
        }),
      ],
      [
        vehicle({ id: "u1", fleetNumber: "HORSE-1", unitKind: "HORSE", status: "ACTIVE" }),
        vehicle({ id: "u9", fleetNumber: "HORSE-9", unitKind: "HORSE", status: "ACTIVE" }),
        vehicle({ id: "u2", fleetNumber: "TRAILER-2", unitKind: "TRAILER", status: "ACTIVE" }),
        vehicle({ id: "u5", fleetNumber: "LINK-5", unitKind: "TRAILER", status: "ACTIVE" }),
        vehicle({ id: "u3", fleetNumber: "DISPOSED-3", unitKind: "TRAILER", status: "DISPOSED" }),
        vehicle({ id: "u4", fleetNumber: "DRIVER-4", unitKind: null, status: "ACTIVE" }),
      ],
    );
    renderForm();

    // The select mounts immediately with only "Choose…"; wait for the
    // vehicles read to resolve and populate it before reading its options.
    await screen.findByRole("option", { name: "HORSE-1" });
    const motive = screen.getByLabelText(/motive unit/i);
    const motiveOptions = within(motive)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(motiveOptions).toContain("HORSE-1");
    expect(motiveOptions).not.toContain("HORSE-9"); // already coupled in an open rig
    expect(motiveOptions).not.toContain("TRAILER-2"); // a trailer, not a motive kind
    expect(motiveOptions).not.toContain("DRIVER-4"); // no unit kind recorded

    const trailer = screen.getByLabelText(/^trailer$/i);
    const trailerOptions = within(trailer)
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(trailerOptions).toContain("TRAILER-2");
    expect(trailerOptions).not.toContain("LINK-5"); // already coupled in an open rig
    expect(trailerOptions).not.toContain("DISPOSED-3"); // retired
    expect(trailerOptions).not.toContain("HORSE-1"); // not a trailer
  });

  it("adds a towed row, reorders it, and removes it", async () => {
    mockLists(
      [],
      [
        vehicle({ id: "u1", fleetNumber: "HORSE-1" }),
        vehicle({ id: "u2", fleetNumber: "LINK-A", unitKind: "TRAILER" }),
        vehicle({ id: "u3", fleetNumber: "LINK-B", unitKind: "TRAILER" }),
      ],
    );
    renderForm();
    await screen.findByRole("option", { name: "LINK-A" });

    await userEvent.selectOptions(screen.getByLabelText(/^trailer$/i), "u2");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.selectOptions(screen.getByLabelText(/^trailer$/i), "u3");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByText("LINK-A")).toBeInTheDocument();
    expect(screen.getByText("LINK-B")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Move LINK-B up" }));
    // After the swap LINK-B leads, so its own Up control is now disabled.
    expect(screen.getByRole("button", { name: "Move LINK-B up" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Remove LINK-A" }));
    // Removing it from the towed list makes it a free trailer again, so it
    // reappears in the Trailer select's own options — scope to the towed
    // list itself rather than the whole document.
    expect(within(screen.getByRole("list")).queryByText("LINK-A")).not.toBeInTheDocument();
  });

  it("disables Set rig until a motive and at least one trailer are chosen", async () => {
    mockLists(
      [],
      [
        vehicle({ id: "u1", fleetNumber: "HORSE-1" }),
        vehicle({ id: "u2", fleetNumber: "LINK-A", unitKind: "TRAILER" }),
      ],
    );
    renderForm();
    await screen.findByRole("option", { name: "HORSE-1" });

    expect(screen.getByRole("button", { name: "Set rig" })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText(/motive unit/i), "u1");
    expect(screen.getByRole("button", { name: "Set rig" })).toBeDisabled();

    await userEvent.selectOptions(screen.getByLabelText(/^trailer$/i), "u2");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getByRole("button", { name: "Set rig" })).toBeEnabled();
  });

  it("never prefills the effective-from date", async () => {
    mockLists([], [vehicle({ id: "u1", fleetNumber: "HORSE-1" })]);
    renderForm();
    expect(await screen.findByLabelText(/effective from/i)).toHaveValue("");
  });

  it("submits motiveVehicleId and towed, omitting effectiveOn when the date is blank", async () => {
    mockLists(
      [],
      [
        vehicle({ id: "u1", fleetNumber: "HORSE-1" }),
        vehicle({ id: "u2", fleetNumber: "LINK-A", unitKind: "TRAILER" }),
      ],
    );
    renderForm();
    await screen.findByRole("option", { name: "HORSE-1" });
    await userEvent.selectOptions(screen.getByLabelText(/motive unit/i), "u1");
    await userEvent.selectOptions(screen.getByLabelText(/^trailer$/i), "u2");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.type(screen.getByLabelText(/descriptor for link-a/i), "front");

    vi.mocked(fetch)
      .mockResolvedValueOnce(
        respond(201, rig({ id: "r1", motiveVehicleId: "u1", motiveFleetNumber: "HORSE-1" })),
      )
      .mockResolvedValueOnce(respond(200, []))
      .mockResolvedValueOnce(
        respond(200, [
          vehicle({ id: "u1", fleetNumber: "HORSE-1" }),
          vehicle({ id: "u2", fleetNumber: "LINK-A", unitKind: "TRAILER" }),
        ]),
      );
    await userEvent.click(screen.getByRole("button", { name: "Set rig" }));

    const status = await screen.findByRole("status");
    expect(status).toHaveTextContent("Rig set for HORSE-1.");
    expect(sentBody(2)).toStrictEqual({
      motiveVehicleId: "u1",
      towed: [{ vehicleId: "u2", descriptor: "front" }],
    });
    // The form clears once the write succeeds — LINK-A leaves the towed
    // list (it still exists as a Trailer option again, now that it is free).
    expect(within(screen.getByRole("list")).queryByText("LINK-A")).not.toBeInTheDocument();
  });

  it("speaks a TY017 refusal in role=alert", async () => {
    mockLists(
      [],
      [
        vehicle({ id: "u1", fleetNumber: "HORSE-1" }),
        vehicle({ id: "u2", fleetNumber: "LINK-A", unitKind: "TRAILER" }),
      ],
    );
    renderForm();
    await screen.findByRole("option", { name: "HORSE-1" });
    await userEvent.selectOptions(screen.getByLabelText(/motive unit/i), "u1");
    await userEvent.selectOptions(screen.getByLabelText(/^trailer$/i), "u2");
    await userEvent.click(screen.getByRole("button", { name: "Add" }));

    vi.mocked(fetch).mockResolvedValueOnce(
      respond(422, { code: "TY017", message: "u2 is named twice in this rig" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Set rig" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("u2 is named twice in this rig");
  });
});
