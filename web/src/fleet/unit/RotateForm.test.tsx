import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { RotateForm } from "./RotateForm";
import { openFitmentsKey, rigsKey, unitKey } from "./queryKeys";
import { ActorContext } from "../../auth/actorContext";
import { getDevTenantId } from "../../api/devTenant";
import type { Rig } from "../../api/combinations";
import type { Unit } from "../../api/units";
import {
  me,
  openFitment,
  requestedUrl,
  respond,
  sentBody,
  testQueryClient,
  unit,
  unitPosition,
} from "../../test/fixtures";

const TENANT = getDevTenantId() ?? "default";

function threePositions(): Unit["positions"] {
  return [
    unitPosition({
      id: "p1",
      code: "POS1",
      fitment: openFitment({ fitmentId: "f1", tyreId: "t1", displayCode: "TY001" }),
    }),
    unitPosition({
      id: "p2",
      code: "POS2",
      side: "RIGHT",
      fitment: openFitment({ fitmentId: "f2", tyreId: "t2", displayCode: "TY002" }),
    }),
    unitPosition({ id: "p3", code: "POS3", axleNumber: 2, fitment: null }),
  ];
}

// The two links of an ordinary superlink share every position id byte for
// byte, because app.position belongs to an axle configuration and not to a
// unit (docs/lessons.md, 26 Aug 2026). The sibling below therefore reuses
// p1/p2/p3: a fixture giving it distinct ids is blind to the whole class of
// bug the (unit, position) pair exists to stop.
function sibling(overrides: Partial<Unit> = {}): Unit {
  return unit({
    id: "u5",
    fleetNumber: "LINK-5",
    unitKind: "TRAILER",
    hasOdometer: false,
    positions: [
      unitPosition({
        id: "p1",
        code: "POS1",
        fitment: openFitment({ fitmentId: "f5", tyreId: "t5", displayCode: "TY005" }),
      }),
      unitPosition({ id: "p2", code: "POS2", side: "RIGHT", fitment: null }),
      unitPosition({ id: "p3", code: "POS3", axleNumber: 2, fitment: null }),
    ],
    ...overrides,
  });
}

function rig(overrides: Partial<Rig> = {}): Rig {
  return {
    id: "r1",
    motiveVehicleId: "u9",
    motiveFleetNumber: "HORSE-1",
    effectiveFrom: "2026-08-01T06:00:00Z",
    effectiveTo: null,
    members: [
      { vehicleId: "u9", fleetNumber: "HORSE-1", sequence: 1, descriptor: null, unitKind: "HORSE" },
      {
        vehicleId: "u5",
        fleetNumber: "LINK-5",
        sequence: 2,
        descriptor: null,
        unitKind: "TRAILER",
      },
    ],
    ...overrides,
  };
}

// Routed by URL rather than by call order: the form issues the rig read, a
// read per sibling and the rotation POST, and every one of those may be
// re-issued by an invalidation. A single mockResolvedValue hands the same
// Response to all of them, and its body can only be read once.
interface Wiring {
  rigs?: Rig[];
  units?: Unit[];
  rotation?: () => Response;
}

function wireFetch(wiring: Wiring) {
  vi.mocked(fetch).mockImplementation((input) => {
    const url = requestedUrl(input);
    if (url === "/api/combinations") {
      return Promise.resolve(respond(200, wiring.rigs ?? []));
    }
    if (url.endsWith("/rotations")) {
      return Promise.resolve(wiring.rotation?.() ?? respond(200, { moves: [] }));
    }
    const read = (wiring.units ?? []).find((u) => url === `/api/vehicles/${u.id}`);
    if (read !== undefined) {
      return Promise.resolve(respond(200, read));
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
}

function rotationCalls(): number[] {
  return vi
    .mocked(fetch)
    .mock.calls.flatMap((call, index) =>
      requestedUrl(call[0]).endsWith("/rotations") ? [index] : [],
    );
}

function rotationBody(): unknown {
  const calls = rotationCalls();
  if (calls.length !== 1) {
    throw new Error(`expected exactly one rotation POST, saw ${calls.length}`);
  }
  return sentBody(calls[0]);
}

function renderForm(overrides: Partial<Unit> = {}, client: QueryClient = testQueryClient()) {
  const u = unit({ id: "u9", positions: threePositions(), ...overrides });
  return {
    client,
    ...render(
      <ActorContext.Provider
        value={{ actor: me({ capabilities: ["ManageAssets"] }), settled: true }}
      >
        <QueryClientProvider client={client}>
          <RotateForm unit={u} />
        </QueryClientProvider>
      </ActorContext.Provider>,
    ),
  };
}

// "No unit column" is trivially true while the rig read is still in flight,
// so every assertion about membership waits for the answer to have landed.
async function rigsSettled(client: QueryClient) {
  await waitFor(() => {
    expect(client.getQueryState(rigsKey(TENANT))?.status).toBe("success");
  });
}

async function siblingSettled(client: QueryClient) {
  await rigsSettled(client);
  await waitFor(() => {
    expect(client.getQueryState(unitKey("u5"))?.status).toBe("success");
  });
}

function optionNames(name: string): string[] {
  return within(screen.getByRole("combobox", { name }))
    .getAllByRole("option")
    .map((option) => option.textContent ?? "");
}

function selectValue(name: string): string {
  const element = screen.getByRole("combobox", { name });
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error(`${name} is not a select`);
  }
  return element.value;
}

// fireEvent.submit, not a click: requestSubmit runs constraint validation
// first, so a click on the button never reaches the form's own guard while a
// required odometer field is empty. The guard is the layer that survives a
// browser that skips validation, and its sentence is what proves it ran.
function submitPastValidation() {
  const form = screen.getByRole("button", { name: "Rotate" }).closest("form");
  if (form === null) {
    throw new Error("the rotate button is not inside a form");
  }
  fireEvent.submit(form);
}

describe("rotating tyres within a unit", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    wireFetch({});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers only the occupied positions — an empty one has nothing to move", () => {
    renderForm();
    expect(screen.getByRole("checkbox", { name: "Rotate POS1" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "Rotate POS3" })).toBeNull();
  });

  it("sends one move per checked position, each with its target and tread", async () => {
    const user = userEvent.setup();
    renderForm({ hasOdometer: true });

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.type(screen.getByRole("textbox", { name: "Odometer" }), "220000");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    expect(await screen.findByText("The rotation was applied.")).toBeTruthy();
    const url = requestedUrl(vi.mocked(fetch).mock.calls[rotationCalls()[0]][0]);
    expect(url).toBe("/api/vehicles/u9/rotations");
    expect(rotationBody()).toEqual({
      moves: [
        { tyreId: "t1", toPositionId: "p2", treadMm: "11.0" },
        { tyreId: "t2", toPositionId: "p1", treadMm: "12.5" },
      ],
      odometer: 220000,
    });
  });

  // U15/U17: a move that names no destination belongs to the unit the request
  // is addressed to, so the key is absent rather than a JSON null the handler
  // would have to read as "this unit" a second time.
  it("names no destination unit, and offers no unit column, outside an open rig", async () => {
    wireFetch({ rigs: [rig({ effectiveTo: "2026-08-20T06:00:00Z" })] });
    const user = userEvent.setup();
    const { client } = renderForm({ hasOdometer: false });
    await rigsSettled(client);

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    expect(screen.queryByRole("combobox", { name: "Unit for POS1" })).toBeNull();

    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p3");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    await screen.findByText("The rotation was applied.");
    const body = rotationBody();
    expect(body).toEqual({
      moves: [
        { tyreId: "t1", toPositionId: "p3", treadMm: "11.0" },
        { tyreId: "t2", toPositionId: "p1", treadMm: "12.5" },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("toVehicleId");
  });

  it("offers the rig's units in each picked row, defaulting to this one", async () => {
    wireFetch({ rigs: [rig()], units: [sibling()] });
    const user = userEvent.setup();
    const { client } = renderForm({ hasOdometer: true });
    await siblingSettled(client);

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));

    expect(optionNames("Unit for POS1")).toEqual(["HORSE-1", "LINK-5"]);
    expect(selectValue("Unit for POS1")).toBe("u9");
  });

  // TYRE-127, and docs/lessons.md 26 Aug 2026: the sibling shares p1/p2/p3
  // with this unit, so a freeness check on the position id alone would offer
  // the sibling's occupied POS1 the moment this unit's POS1 is vacated.
  it("offers only the positions free on the chosen unit, per (unit, position) pair", async () => {
    wireFetch({ rigs: [rig()], units: [sibling()] });
    const user = userEvent.setup();
    const { client } = renderForm({
      hasOdometer: true,
      positions: [
        ...threePositions(),
        unitPosition({
          id: "p4",
          code: "POS4",
          axleNumber: 2,
          side: "RIGHT",
          fitment: openFitment({ fitmentId: "f4", tyreId: "t4", displayCode: "TY004" }),
        }),
      ],
    });
    await siblingSettled(client);

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));

    // POS2 is vacated by the other picked row and offered; POS4 is occupied
    // and unmoved, so it is not.
    expect(optionNames("Target for POS1")).toEqual(["Choose…", "POS1", "POS2", "POS3"]);

    await user.selectOptions(screen.getByRole("combobox", { name: "Unit for POS1" }), "u5");

    expect(optionNames("Target for POS1")).toEqual(["Choose…", "POS2", "POS3"]);
    // Cleared with the unit: p1 is a legal id on both units, so a carried
    // selection would name a position this picker does not offer.
    expect(selectValue("Target for POS1")).toBe("");
  });

  // A position is offerable because some other picked row is leaving it, so
  // unchecking that row takes it back out of every picker while the select
  // that named it still holds the id. The body is built from the same answer
  // the picker gives, so the id is refused here rather than posted onto a
  // position its tyre never left.
  it("refuses a target that has stopped being offerable since it was picked", async () => {
    const user = userEvent.setup();
    renderForm({
      hasOdometer: false,
      positions: [
        ...threePositions(),
        unitPosition({
          id: "p4",
          code: "POS4",
          axleNumber: 2,
          side: "RIGHT",
          fitment: openFitment({ fitmentId: "f4", tyreId: "t4", displayCode: "TY004" }),
        }),
      ],
    });

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS4" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS4" }), "p3");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS4" }), "13.0");

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));

    // POS2 is occupied again by a tyre that is not moving, so it is gone from
    // POS1's options and the control shows nothing chosen.
    expect(optionNames("Target for POS1")).toEqual(["Choose…", "POS1", "POS3", "POS4"]);
    expect(selectValue("Target for POS1")).toBe("");

    await user.click(screen.getByRole("button", { name: "Rotate" }));

    expect(screen.getByRole("alert").textContent).toBe(
      "Every picked position needs a target and a tread reading.",
    );
    expect(rotationCalls()).toEqual([]);
  });

  // FR-FIT-002/U20: the reading belongs to the unit, so a rotation across two
  // of them sends one per unit that has an odometer — a trailer has none.
  it("asks an odometer per unit and sends odometers when the rotation crosses units", async () => {
    wireFetch({ rigs: [rig()], units: [sibling()] });
    const user = userEvent.setup();
    const { client } = renderForm({ hasOdometer: true });
    await siblingSettled(client);

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Unit for POS1" }), "u5");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");

    expect(screen.queryByRole("textbox", { name: "Odometer" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Odometer for LINK-5" })).toBeNull();
    await user.type(screen.getByRole("textbox", { name: "Odometer for HORSE-1" }), "220000");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    await screen.findByText("The rotation was applied.");
    expect(rotationBody()).toEqual({
      moves: [
        { tyreId: "t1", toVehicleId: "u5", toPositionId: "p2", treadMm: "11.0" },
        { tyreId: "t2", toPositionId: "p1", treadMm: "12.5" },
      ],
      odometers: { u9: 220000 },
    });
  });

  // Both forms in one body are refused as a wire-shape contradiction (U20),
  // so a rotation that stays on this unit keeps sending the single reading
  // even while the unit sits in a rig.
  it("still sends the single odometer when every move stays on this unit", async () => {
    wireFetch({ rigs: [rig()], units: [sibling()] });
    const user = userEvent.setup();
    const { client } = renderForm({ hasOdometer: true });
    await siblingSettled(client);

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.type(screen.getByRole("textbox", { name: "Odometer" }), "220000");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    await screen.findByText("The rotation was applied.");
    expect(rotationBody()).toEqual({
      moves: [
        { tyreId: "t1", toPositionId: "p2", treadMm: "11.0" },
        { tyreId: "t2", toPositionId: "p1", treadMm: "12.5" },
      ],
      odometer: 220000,
    });
  });

  // A rotation lands fitments on every unit it names, so a sibling's read
  // under unitKey is as stale as this unit's and UnitDetail would otherwise
  // keep showing a position the move has just filled.
  it("invalidates every unit of the rig, not only this one", async () => {
    wireFetch({ rigs: [rig()], units: [sibling()] });
    const user = userEvent.setup();
    const client = testQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    renderForm({ hasOdometer: false }, client);
    await siblingSettled(client);

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Unit for POS1" }), "u5");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    await screen.findByText("The rotation was applied.");
    expect(invalidate).toHaveBeenCalledWith({ queryKey: unitKey("u5") });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: unitKey("u9") });
  });

  // useFormMutation keeps isSuccess, so without gating the confirmation the
  // next refused attempt would read "The rotation was applied" beside "Pick at
  // least two positions".
  it("drops the standing confirmation when the next attempt is refused", async () => {
    const user = userEvent.setup();
    renderForm({ hasOdometer: false });

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.click(screen.getByRole("button", { name: "Rotate" }));
    await screen.findByText("The rotation was applied.");

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    expect(screen.getByRole("alert").textContent).toContain("two positions");
    expect(screen.queryByText("The rotation was applied.")).toBeNull();
  });

  // CLAUDE.md rule 3 / CR-012: a truncated reading lands on an immutable
  // event, so the form refuses rather than parses what it can.
  it.each(["125 000", "125.7"])(
    "refuses the odometer %s rather than sending a truncated reading",
    async (typed) => {
      const user = userEvent.setup();
      renderForm({ hasOdometer: true });

      await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
      await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
      await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
      await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
      await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
      await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
      await user.type(screen.getByRole("textbox", { name: "Odometer" }), typed);
      await user.click(screen.getByRole("button", { name: "Rotate" }));

      expect(screen.getByRole("alert").textContent).toContain("digits only");
      expect(rotationCalls()).toEqual([]);
    },
  );

  // The reading is parsed per unit, so the refusal has to reach a field that
  // is not this unit's own (TYRE-128: only the fit path had these).
  it("refuses a per-unit odometer that is not whole kilometres", async () => {
    wireFetch({ rigs: [rig()], units: [sibling({ hasOdometer: true })] });
    const user = userEvent.setup();
    const { client } = renderForm({ hasOdometer: true });
    await siblingSettled(client);

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Unit for POS1" }), "u5");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.type(screen.getByRole("textbox", { name: "Odometer for HORSE-1" }), "220000");
    await user.type(screen.getByRole("textbox", { name: "Odometer for LINK-5" }), "88 000");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    expect(screen.getByRole("alert").textContent).toContain("digits only");
    expect(rotationCalls()).toEqual([]);
  });

  // FR-FIT-002: 000025's trigger refuses the whole write for a missing
  // reading, so the blank is refused here rather than round-tripped. The
  // required attribute is the first layer and this guard the second — the
  // submit below is dispatched past constraint validation to reach it.
  it("refuses a blank odometer on a unit that has one", async () => {
    const user = userEvent.setup();
    renderForm({ hasOdometer: true });

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    submitPastValidation();

    expect(screen.getByRole("alert").textContent).toBe(
      "Enter the odometer: this unit needs a reading with every write.",
    );
    expect(rotationCalls()).toEqual([]);
  });

  it("refuses a blank per-unit odometer when the rotation crosses units", async () => {
    wireFetch({ rigs: [rig()], units: [sibling({ hasOdometer: true })] });
    const user = userEvent.setup();
    const { client } = renderForm({ hasOdometer: true });
    await siblingSettled(client);

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Unit for POS1" }), "u5");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.type(screen.getByRole("textbox", { name: "Odometer for HORSE-1" }), "220000");
    submitPastValidation();

    expect(screen.getByRole("alert").textContent).toBe(
      "Enter the odometer: this unit needs a reading with every write.",
    );
    expect(rotationCalls()).toEqual([]);
  });

  // D7: a rotation is two or more positions swapping. One checked position
  // is a removal and a fit, which this form is not.
  it("refuses to send a rotation of one position", async () => {
    const user = userEvent.setup();
    renderForm({ hasOdometer: false });

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p3");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    expect(rotationCalls()).toEqual([]);
    expect(screen.getByRole("alert").textContent).toContain("two positions");
  });

  // A rotation moves tyres between positions, which changes what the
  // fleet-wide fitments list holds for every one of them. No screen here reads
  // that list, so its key is stale only if this write says so.
  it("invalidates the fleet-wide fitments list its moves make stale", async () => {
    const user = userEvent.setup();
    const client = testQueryClient();
    const key = openFitmentsKey(TENANT);
    // Seeded first: invalidateQueries on a key with no cache entry is
    // silently a no-op (PositionPanel.test.tsx holds the same note).
    client.setQueryData(key, []);
    renderForm({ hasOdometer: false }, client);

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    await waitFor(() => {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    });
  });

  // Every move closes a fitment row, and 000025's trigger refuses a closure
  // on a unit that has an odometer without the reading (FR-FIT-002). A rotation
  // sent from a stale unit read gets that refusal, and a general sentence
  // would leave the controller retrying the same thing (ADR-0012).
  it("speaks TY009 rather than the general sentence", async () => {
    const message = "fitment odometer is required for a unit that has one";
    wireFetch({ rotation: () => respond(422, { code: "TY009", message }) });
    const user = userEvent.setup();
    renderForm({ hasOdometer: false });

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  // 000039 reworded this one, and the form must not pattern-match on it: the
  // server's sentence names the casing and reaches the controller verbatim.
  it("speaks TY014 verbatim rather than the general sentence", async () => {
    const message = "tyre TY001 is not on this unit or its rig";
    wireFetch({
      rigs: [rig()],
      units: [sibling()],
      rotation: () => respond(422, { code: "TY014", message }),
    });
    const user = userEvent.setup();
    const { client } = renderForm({ hasOdometer: false });
    await siblingSettled(client);

    await user.click(screen.getByRole("checkbox", { name: "Rotate POS1" }));
    await user.click(screen.getByRole("checkbox", { name: "Rotate POS2" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Unit for POS1" }), "u5");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS1" }), "p2");
    await user.selectOptions(screen.getByRole("combobox", { name: "Target for POS2" }), "p1");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS1" }), "11.0");
    await user.type(screen.getByRole("textbox", { name: "Tread for POS2" }), "12.5");
    await user.click(screen.getByRole("button", { name: "Rotate" }));

    expect((await screen.findByRole("alert")).textContent).toBe(message);
  });

  it("never asks a trailer for an odometer and asks a horse for one", () => {
    const { unmount } = renderForm({ hasOdometer: true });
    // Required, not optional: without it the write is refused as TY009.
    expect(screen.getByRole("textbox", { name: "Odometer" }).hasAttribute("required")).toBe(true);
    unmount();

    renderForm({ hasOdometer: false, unitKind: "TRAILER" });
    expect(screen.queryByRole("textbox", { name: "Odometer" })).toBeNull();
  });
});
