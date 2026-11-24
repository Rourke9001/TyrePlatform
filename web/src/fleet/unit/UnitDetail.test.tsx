import { QueryClientProvider, focusManager, type QueryClient } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { UnitDetail } from "./UnitDetail";
import { rigsKey } from "./queryKeys";
import { ActorContext } from "../../auth/actorContext";
import { getDevTenantId } from "../../api/devTenant";
import type { Rig } from "../../api/combinations";
import type { ExceptionRow } from "../../api/dashboard";
import type { InspectionDetail, UnitInspectionPage } from "../../api/inspections";
import { forceMatchMedia } from "../../test/media";
import {
  dashboardBody,
  exceptionRow,
  fitmentRow,
  inspectionDetail,
  inspectionReading,
  me,
  openFitment,
  requestedUrl,
  respond,
  testQueryClient,
  unit,
  unitInspection,
  unitPosition,
} from "../../test/fixtures";

const TENANT = getDevTenantId() ?? "default";

const UNIT = unit({
  id: "u9",
  fleetNumber: "HORSE-1",
  positions: [
    unitPosition({ id: "p1", code: "POS1" }),
    unitPosition({
      id: "p2",
      code: "POS2",
      side: "RIGHT",
      fitment: openFitment({ displayCode: "TY100" }),
    }),
  ],
});

// The rig this unit sits in, in the server's own member order: the motive is
// always sequence 1 with a null descriptor (U7).
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

// The unit's inspection reads (TYRE-325). The default is settled and
// empty, so a tile's name settles to its unread form rather than racing
// the first render (red team I1).
interface InspectionReads {
  page?: () => Promise<Response>;
  older?: () => Promise<Response>;
  detail?: (inspectionId: string) => Promise<Response>;
  exceptions?: () => Promise<Response>;
}

const NO_INSPECTIONS: UnitInspectionPage = {
  inspections: [],
  nextAfter: null,
  latestInspectionId: null,
};

function exceptionsBody(rows: ExceptionRow[]) {
  return { scope: dashboardBody().scope, judgedAt: "SUBMITTED_AT", exceptions: rows };
}

// A latest inspection i1 that read TY100's tyre at POS2, with the rows
// given, all judged on i1.
function readAtPos2(rows: ExceptionRow[]): InspectionReads {
  const detail: InspectionDetail = inspectionDetail({
    inspection: unitInspection({ inspectionId: "i1" }),
    readings: [inspectionReading({ positionId: "p2", positionCode: "POS2", tyreId: "t1" })],
  });
  return {
    page: () =>
      Promise.resolve(
        respond(200, {
          inspections: [unitInspection({ inspectionId: "i1" })],
          nextAfter: null,
          latestInspectionId: "i1",
        }),
      ),
    detail: (id) =>
      Promise.resolve(id === "i1" ? respond(200, detail) : respond(404, { code: "not_found" })),
    exceptions: () => Promise.resolve(respond(200, exceptionsBody(rows))),
  };
}

function stubFetch(rigs: Rig[] = [], reads: InspectionReads = {}) {
  vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
    const url = requestedUrl(input);
    if (url === "/api/vehicles/u9/inspections")
      return reads.page?.() ?? Promise.resolve(respond(200, NO_INSPECTIONS));
    if (url.startsWith("/api/vehicles/u9/inspections?after="))
      return reads.older?.() ?? Promise.resolve(respond(200, NO_INSPECTIONS));
    if (url.startsWith("/api/vehicles/u9/inspections/"))
      return (
        reads.detail?.(url.slice("/api/vehicles/u9/inspections/".length)) ??
        Promise.resolve(respond(404, { code: "not_found" }))
      );
    if (url === "/api/exceptions?vehicle=u9")
      return reads.exceptions?.() ?? Promise.resolve(respond(200, exceptionsBody([])));
    if (url === "/api/vehicles/u9") return Promise.resolve(respond(200, UNIT));
    if (url === "/api/combinations") return Promise.resolve(respond(200, rigs));
    if (url === "/api/vehicles/u9/fitments")
      return Promise.resolve(respond(200, [fitmentRow({ fitmentId: "f1", displayCode: "TY100" })]));
    if (url === "/api/vehicles/u9/trip")
      return Promise.resolve(respond(200, { trip: null, pulledBy: null }));
    if (url === "/api/drivers") return Promise.resolve(respond(200, []));
    if (url === "/api/vehicles") return Promise.resolve(respond(200, []));
    if (url.startsWith("/api/vehicles/u9/trip-blockers")) return Promise.resolve(respond(200, []));
    if (url === "/api/vehicles/u9/inspection-tasks") return Promise.resolve(respond(200, []));
    if (url.startsWith("/api/tyres")) return Promise.resolve(respond(200, { tyres: [] }));
    if (url.startsWith("/api/depots")) return Promise.resolve(respond(200, []));
    throw new Error(`unstubbed ${url}`);
  });
}

function renderScreen(
  capabilities: string[] = ["ViewFleet", "ManageAssets"],
  client: QueryClient = testQueryClient(),
) {
  return {
    client,
    ...render(
      <ActorContext.Provider value={{ actor: me({ capabilities }), settled: true }}>
        <QueryClientProvider client={client}>
          {/* UnitDetail links to the Rigs screen, and react-router refuses a
              Link outside a router. */}
          <MemoryRouter>
            <UnitDetail unitId="u9" />
          </MemoryRouter>
        </QueryClientProvider>
      </ActorContext.Provider>,
    ),
  };
}

// "No rig line" is trivially true while the rig read is still in flight, so
// the absence half below waits for the answer to have landed first
// (RotateForm.test.tsx's own guard against the same vacuous assertion).
async function rigsSettled(client: QueryClient) {
  await waitFor(() => {
    expect(client.getQueryState(rigsKey(TENANT))?.status).toBe("success");
  });
}

describe("the unit screen", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    stubFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the unit and draws its plan", async () => {
    renderScreen();
    expect(await screen.findByRole("heading", { name: "HORSE-1" })).toBeTruthy();
    expect(
      await screen.findByRole("button", { name: "Position POS2: TY100, Not read" }),
    ).toBeTruthy();
  });

  it("opens the picked position's panel", async () => {
    const user = userEvent.setup();
    renderScreen();
    await user.click(await screen.findByRole("button", { name: "Position POS2: TY100, Not read" }));

    expect(await screen.findByRole("combobox", { name: "Reason" })).toBeTruthy();
  });

  // ViewFleet is the read (D7). Every write on this screen needs a further
  // capability: ManageAssets for rotate/edit/status, ManageAssignments for
  // the schedule form (spec U2), so a reader is shown the unit rather than
  // a row of controls that would refuse them.
  it("shows a reader the plan and the history and none of the writes", async () => {
    renderScreen(["ViewFleet"]);
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.getByRole("button", { name: "Position POS1: empty" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Rotate" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Set status" })).toBeNull();
  });

  // Every ViewFleet reader sees the trip panel; its controls are
  // ManageAssignments' (spec, Trip screens).
  it("shows a reader the trip panel with no trip controls", async () => {
    renderScreen(["ViewFleet"]);

    expect(await screen.findByRole("heading", { name: "Trip" })).toBeInTheDocument();
    expect(await screen.findByText("Not on a trip.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start trip" })).toBeNull();
    expect(screen.queryByRole("button", { name: "End trip" })).toBeNull();
  });

  // A TECHNICIAN reads this screen, so the prompt offers only what the
  // reader can do. The position panel shows them the tyre and no form.
  it("prompts a reader to look and a manager to fit or remove", async () => {
    const reader = renderScreen(["ViewFleet"]);
    await screen.findByRole("heading", { name: "HORSE-1" });
    expect(screen.getByText("Pick a position on the plan to see its tyre.")).toBeTruthy();
    expect(screen.queryByText(/fit or remove/)).toBeNull();
    reader.unmount();

    renderScreen();
    await screen.findByRole("heading", { name: "HORSE-1" });
    expect(screen.getByText("Pick a position on the plan to fit or remove a tyre.")).toBeTruthy();
  });

  it("gives a controller the rotate, edit and status forms", async () => {
    renderScreen();
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.getByRole("button", { name: "Rotate" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set status" })).toBeTruthy();
  });

  it("says the unit did not load rather than rendering an empty screen", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(500, {}));
    renderScreen();
    expect((await screen.findByRole("alert")).textContent).toContain("Unit didn't load");
  });

  // The list is every ViewFleet reader's (spec U2), so it renders whether or
  // not the schedule form does.
  it("shows a reader Open inspections but not the schedule form", async () => {
    renderScreen(["ViewFleet"]);
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.getByRole("heading", { name: "Open inspections" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Schedule an inspection" })).toBeNull();
  });

  // The capability split is real (spec U2): ManageAssets, which gates the
  // other forms on this screen, does not also gate the schedule form.
  it("keeps the schedule form hidden for ManageAssets alone", async () => {
    renderScreen(["ViewFleet", "ManageAssets"]);
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.queryByRole("heading", { name: "Schedule an inspection" })).toBeNull();
  });

  it("gives ManageAssignments the schedule form", async () => {
    renderScreen(["ViewFleet", "ManageAssignments"]);
    await screen.findByRole("heading", { name: "HORSE-1" });

    expect(screen.getByRole("heading", { name: "Schedule an inspection" })).toBeTruthy();
  });

  // UnitDetail's own reason for the line; both halves asserted so an ended
  // rig cannot read as a live coupling.
  it("names the open rig's other units and says nothing about one already ended", async () => {
    stubFetch([rig()]);
    const { unmount } = renderScreen(["ViewFleet"]);

    const link = await screen.findByRole("link", { name: "LINK-5" });
    expect(link.getAttribute("href")).toBe("/fleet/rigs");
    expect(screen.getByText(/^In a rig with/).textContent).toBe("In a rig with LINK-5");
    unmount();

    stubFetch([rig({ effectiveTo: "2026-08-20T06:00:00Z" })]);
    const ended = renderScreen(["ViewFleet"]);
    await screen.findByRole("heading", { name: "HORSE-1" });
    await rigsSettled(ended.client);

    expect(screen.queryByText(/^In a rig with/)).toBeNull();
  });
  // TYRE-325 spec section 3: condition from the latest inspection, judged by
  // app.v_exception through GET /api/exceptions?vehicle=.
  it("marks a position Critical when the latest inspection read its tyre and a CRITICAL row names it", async () => {
    stubFetch(
      [],
      readAtPos2([
        exceptionRow({
          subjectId: "t1",
          vehicleId: "u9",
          positionCode: "POS2",
          severity: "CRITICAL",
          inspectionId: "i1",
        }),
      ]),
    );
    renderScreen(["ViewFleet"]);

    expect(
      await screen.findByRole("button", {
        name: "Position POS2: TY100, Critical",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Position POS1: empty" })).toBeTruthy();
  });

  it("lists a rule that names no position beside the plan, in words", async () => {
    stubFetch(
      [],
      readAtPos2([
        exceptionRow({
          subjectId: "u9",
          subjectType: "VEHICLE",
          vehicleId: "u9",
          ruleCode: "FR-EXC-039",
          ruleName: "Pressure spread across the unit",
          severity: "WARNING",
          positionCode: null,
          inspectionId: "i1",
        }),
      ]),
    );
    renderScreen(["ViewFleet"]);

    expect(await screen.findByText("Pressure spread across the unit: Warning")).toBeTruthy();
  });

  it("draws no condition while the condition read is pending", async () => {
    stubFetch([], { exceptions: () => new Promise<Response>(() => undefined) });
    renderScreen(["ViewFleet"]);

    expect(await screen.findByRole("button", { name: "Position POS2: TY100" })).toBeTruthy();
  });

  it("says the condition could not be loaded, and retries", async () => {
    let failing = true;
    stubFetch([], {
      exceptions: () =>
        Promise.resolve(failing ? respond(500, {}) : respond(200, exceptionsBody([]))),
    });
    const user = userEvent.setup();
    renderScreen(["ViewFleet"]);

    expect(await screen.findByText("Condition could not be loaded.")).toBeTruthy();
    failing = false;
    await user.click(screen.getByRole("button", { name: "Retry the condition" }));
    expect(
      await screen.findByRole("button", {
        name: "Position POS2: TY100, Not read",
      }),
    ).toBeTruthy();
  });

  // U41 (spec section 3 at 17509df1): the exceptions read builds the whole
  // tenant's latest readings, so a focus event does not refetch it.
  it("does not read the condition again on window focus", async () => {
    const calls = (path: string) =>
      vi.mocked(fetch).mock.calls.filter(([input]) => requestedUrl(input) === path).length;
    renderScreen(["ViewFleet"]);
    await screen.findByRole("button", { name: "Position POS2: TY100, Not read" });
    expect(calls("/api/exceptions?vehicle=u9")).toBe(1);
    expect(calls("/api/vehicles/u9")).toBe(1);

    act(() => {
      focusManager.setFocused(false);
    });
    act(() => {
      focusManager.setFocused(true);
    });

    await waitFor(() => {
      expect(calls("/api/vehicles/u9")).toBe(2);
    });
    expect(calls("/api/exceptions?vehicle=u9")).toBe(1);
    act(() => {
      focusManager.setFocused(undefined);
    });
  });

  describe("the Inspections card", () => {
    const LIST: UnitInspectionPage = {
      inspections: [
        unitInspection({
          inspectionId: "i2",
          latest: true,
          submittedAt: "2026-11-20T08:03:00Z",
          odometerKm: 412300,
          positionsRead: 10,
          warningCount: 2,
          driver: { id: "d1", displayName: "Melusi" },
        }),
        unitInspection({
          inspectionId: "i1",
          latest: false,
          state: "VOIDED",
          voidedBy: "Nomsa",
          voidReason: "wrong rig",
          voidedAt: "2026-11-21T10:05:00Z",
          submittedAt: "2026-11-19T08:03:00Z",
          odometerKm: 412000,
          positionsRead: 8,
          warningCount: 0,
        }),
      ],
      nextAfter: null,
      latestInspectionId: "i2",
    };

    const listOf = (page: UnitInspectionPage): InspectionReads => ({
      page: () => Promise.resolve(respond(200, page)),
      detail: () => Promise.resolve(respond(200, inspectionDetail())),
    });

    const region = () => screen.findByRole("region", { name: "Inspections" });

    it("lists the unit's inspections newest first with their marks, odometer and counts", async () => {
      stubFetch([], listOf(LIST));
      renderScreen(["ViewFleet"]);

      const card = await region();
      const rows = await within(card).findAllByRole("row");
      expect(rows).toHaveLength(3);
      // One region carries the card's name: the table's own is its caption.
      expect(screen.getAllByRole("region", { name: "Inspections" })).toHaveLength(1);
      const [newest, voided] = rows.slice(1);
      expect(newest).toHaveTextContent("Melusi");
      expect(newest).toHaveTextContent("Latest");
      expect(newest).toHaveTextContent("412,300 km");
      expect(
        within(newest)
          .getAllByRole("cell")
          .map((c) => c.textContent),
      ).toEqual(expect.arrayContaining(["10", "2"]));
      expect(voided).toHaveTextContent("Voided by Nomsa on 21 Nov 2026 12:05. Reason: wrong rig.");
      expect(voided).not.toHaveTextContent("Latest");

      const link = within(newest).getByRole("link", {
        name: "20 Nov 2026 10:03",
      });
      expect(link.getAttribute("href")).toBe("/fleet/units/u9/inspections/i2");
      // The link is the row's one way in: a clickable row would be a second
      // tab stop beside it, and a second control of the same name on a phone.
      expect(newest.getAttribute("tabindex")).toBeNull();
    });

    it("says it is loading while the list is pending", async () => {
      stubFetch([], { page: () => new Promise<Response>(() => undefined) });
      renderScreen(["ViewFleet"]);

      expect(await within(await region()).findByText("Loading…")).toBeTruthy();
    });

    it("says when the unit has no inspections", async () => {
      renderScreen(["ViewFleet"]);

      expect(await within(await region()).findByText("No inspections yet.")).toBeTruthy();
    });

    it("says the list failed and refetches on Retry", async () => {
      let failing = true;
      stubFetch([], {
        page: () => Promise.resolve(failing ? respond(500, {}) : respond(200, LIST)),
        detail: () => Promise.resolve(respond(200, inspectionDetail())),
      });
      const user = userEvent.setup();
      renderScreen(["ViewFleet"]);

      const card = await region();
      expect(await within(card).findByRole("alert")).toHaveTextContent(
        "The inspections could not be loaded.",
      );
      failing = false;
      await user.click(within(card).getByRole("button", { name: "Retry" }));
      expect(await within(card).findByText("412,300 km")).toBeTruthy();
    });

    it("draws a card per inspection on a phone", async () => {
      const restore = forceMatchMedia(true);
      try {
        stubFetch([], listOf(LIST));
        renderScreen(["ViewFleet"]);

        const card = await region();
        const list = await within(card).findByRole("list", {
          name: "Inspections, newest first",
        });
        expect(within(list).getAllByRole("listitem")).toHaveLength(2);
        expect(within(card).queryByRole("table")).toBeNull();
      } finally {
        restore();
      }
    });

    it("loads older inspections on request and appends them", async () => {
      stubFetch([], {
        ...listOf({ ...LIST, nextAfter: "i1" }),
        older: () =>
          Promise.resolve(
            respond(200, {
              inspections: [
                unitInspection({
                  inspectionId: "i0",
                  latest: false,
                  submittedAt: "2026-11-01T08:03:00Z",
                  driver: { id: "d2", displayName: "Sipho" },
                }),
              ],
              nextAfter: null,
              latestInspectionId: "i2",
            }),
          ),
      });
      const user = userEvent.setup();
      renderScreen(["ViewFleet"]);

      const card = await region();
      await user.click(
        await within(card).findByRole("button", {
          name: "Show older inspections",
        }),
      );

      expect(await within(card).findByText("Sipho")).toBeTruthy();
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([input]) => requestedUrl(input) === "/api/vehicles/u9/inspections?after=i1",
          ),
      ).toBe(true);
      expect(within(card).getAllByRole("row")).toHaveLength(4);
      expect(within(card).queryByRole("button", { name: "Show older inspections" })).toBeNull();
    });
  });
});
