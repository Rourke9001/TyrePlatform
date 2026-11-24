import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InspectionPage } from "./InspectionPage";
import type { InspectionDetail } from "../../api/inspections";
import { forceMatchMedia } from "../../test/media";
import {
  inspectionDetail,
  inspectionReading,
  renderWithActor,
  requestedUrl,
  respond,
  unitInspection,
} from "../../test/fixtures";

const PATH = "/api/vehicles/u9/inspections/i1";

const DETAIL: InspectionDetail = inspectionDetail({
  inspection: unitInspection({
    inspectionId: "i1",
    fleetNumber: "LINK-6",
    latest: true,
    submittedAt: "2026-11-20T08:03:00Z",
    driver: { id: "d1", displayName: "Melusi" },
    addressedHere: false,
    addressedUnit: { fleetNumber: "H12", vehicleId: "h12" },
    odometerKm: 412300,
    comment: "rig walked",
    defectReport: "mud flap loose",
  }),
  units: [
    { fleetNumber: "H12", vehicleId: "h12", inScope: true, addressed: true },
    { fleetNumber: "LINK-6", vehicleId: "u9", inScope: true, addressed: false },
    { fleetNumber: "LINK-12", vehicleId: null, inScope: false, addressed: false },
  ],
  readings: [
    inspectionReading({
      positionId: "p1",
      positionCode: "1",
      displayCode: "TY001",
      treadsMm: [5, 4, 4],
      governingTreadMm: 4,
      governingIndex: 1,
      pressureKpa: 780,
      targetKpa: 800,
      pressureBasis: "COLD",
      damageFlag: true,
      damageType: "Sidewall cut",
      note: "check again",
    }),
    inspectionReading({
      positionId: "p2",
      positionCode: "2",
      displayCode: "TY002",
      treadsMm: [],
      treadAnatomy: [],
      governingTreadMm: null,
      governingIndex: null,
      orientationKnown: null,
    }),
  ],
  absentSpares: [{ positionId: "pS", positionCode: "S" }],
  warnings: [
    {
      code: "FR-INS-037",
      source: "CLIENT",
      enteredValue: "640",
      response: "ACKNOWLEDGED",
      raisedAt: "2026-11-20T08:02:00Z",
      positionCode: "1",
    },
    {
      code: "FR-INS-063",
      source: "SERVER",
      enteredValue: null,
      response: null,
      raisedAt: "2026-11-20T08:03:00Z",
      positionCode: null,
    },
    {
      code: "XYZ-1",
      source: "SERVER",
      enteredValue: null,
      response: null,
      raisedAt: "2026-11-20T08:03:01Z",
      positionCode: null,
    },
  ],
});

function serve(answer: () => Promise<Response>) {
  vi.mocked(fetch).mockImplementation((input) => {
    const url = requestedUrl(input);
    if (url === PATH) return answer();
    throw new Error(`unstubbed ${url}`);
  });
}

function renderPage(capabilities: string[] = ["ViewFleet"]) {
  return renderWithActor(<InspectionPage unitId="u9" inspectionId="i1" />, {
    capabilities,
    withRouter: true,
  });
}

function asked(): number {
  return vi.mocked(fetch).mock.calls.filter(([input]) => requestedUrl(input) === PATH).length;
}

describe("the inspection page", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("says it is loading", () => {
    serve(() => new Promise<Response>(() => undefined));
    renderPage();
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("says it did not load, and retries", async () => {
    let failing = true;
    serve(() => Promise.resolve(failing ? respond(500, {}) : respond(200, DETAIL)));
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("Inspection didn't load");
    failing = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("LINK-6");
  });

  it("says an inspection not on this unit is not, after one request", async () => {
    serve(() =>
      Promise.resolve(respond(404, { code: "not_found", message: "no such inspection" })),
    );
    renderPage();

    expect(await screen.findByText("This inspection is not on this unit.")).toBeInTheDocument();
    expect(asked()).toBe(1);
  });

  it("heads the page with the unit, the instant, the driver, the odometer and the latest mark", async () => {
    serve(() => Promise.resolve(respond(200, DETAIL)));
    renderPage();

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("LINK-6");
    expect(screen.getByRole("link", { name: /Back to LINK-6/ }).getAttribute("href")).toBe(
      "/fleet/units/u9",
    );
    expect(screen.getByText("20 Nov 2026 10:03")).toBeInTheDocument();
    expect(screen.getByText("Melusi")).toBeInTheDocument();
    expect(screen.getByText("H12: 412,300 km")).toBeInTheDocument();
    expect(screen.getByText("Latest inspection")).toBeInTheDocument();
  });

  it("shows a voided inspection's banner with who, when and why", async () => {
    const voided = {
      ...DETAIL,
      inspection: {
        ...DETAIL.inspection,
        latest: false,
        state: "VOIDED",
        voidReason: "wrong rig",
        voidedBy: "Nomsa",
        voidedAt: "2026-11-21T10:05:00Z",
      },
    };
    serve(() => Promise.resolve(respond(200, voided)));
    renderPage();

    // The page's own status line is a second status region, empty here.
    const text = await screen.findByText(
      "Voided by Nomsa on 21 Nov 2026 12:05. Reason: wrong rig.",
    );
    const banner = text.closest("[role='status']");
    expect(banner).not.toBeNull();
    expect(banner).toHaveTextContent("Voided");
    expect(screen.queryByText("Latest inspection")).toBeNull();
  });

  it("shows the driver's comment and defect report", async () => {
    serve(() => Promise.resolve(respond(200, DETAIL)));
    renderPage();

    expect(await screen.findByText("rig walked")).toBeInTheDocument();
    expect(screen.getByText("mud flap loose")).toBeInTheDocument();
  });

  it("links the other units in scope and names the others", async () => {
    serve(() => Promise.resolve(respond(200, DETAIL)));
    renderPage();

    const region = await screen.findByRole("region", { name: "Read with" });
    expect(within(region).getByRole("link", { name: /H12/ }).getAttribute("href")).toBe(
      "/fleet/units/h12/inspections/i1",
    );
    expect(within(region).getByText(/LINK-12/)).toBeInTheDocument();
    expect(within(region).queryByRole("link", { name: /LINK-12/ })).toBeNull();
    expect(within(region).queryByText(/LINK-6/)).toBeNull();
  });

  it("lists the warnings in words, with position, value and response", async () => {
    serve(() => Promise.resolve(respond(200, DETAIL)));
    renderPage();

    const region = await screen.findByRole("region", { name: "Warnings" });
    const rows = within(region).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("Pressure off target");
    expect(rows[0]).toHaveTextContent("640 kPa");
    expect(rows[0]).toHaveTextContent("Acknowledged");
    expect(rows[1]).toHaveTextContent("Rig differs from the register");
    expect(rows[1]).not.toHaveTextContent("[");
    expect(rows[2]).toHaveTextContent("Other warning (XYZ-1)");
  });

  it("says when no warnings were recorded", async () => {
    serve(() => Promise.resolve(respond(200, { ...DETAIL, warnings: [] })));
    renderPage();

    expect(await screen.findByText("No warnings were recorded.")).toBeInTheDocument();
  });

  it("lists each position's readings, the lowest, the pressure, damage and note, and an absent spare", async () => {
    serve(() => Promise.resolve(respond(200, DETAIL)));
    renderPage();

    const region = await screen.findByRole("region", { name: "Readings" });
    const rows = within(region).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    const [first, second, spare] = rows;
    expect(within(first).getByText("Lowest")).toBeInTheDocument();
    expect(first).toHaveTextContent("4.0 mm");
    expect(first).toHaveTextContent("780 of 800 kPa, cold");
    expect(first).toHaveTextContent("Sidewall cut");
    expect(first).toHaveTextContent("check again");
    expect(second).toHaveTextContent("No tread entered");
    expect(spare).toHaveTextContent("Reported absent");
  });

  it("draws the readings as cards on a phone", async () => {
    const restore = forceMatchMedia(true);
    try {
      serve(() => Promise.resolve(respond(200, DETAIL)));
      renderPage();

      const region = await screen.findByRole("region", { name: "Readings" });
      expect(
        within(region).getByRole("list", { name: "Readings by position" }),
      ).toBeInTheDocument();
      expect(within(region).queryByRole("table")).toBeNull();
    } finally {
      restore();
    }
  });
  // FR-INS-012: VoidInspection's, and only while the inspection stands.
  it("offers the void to a holder of VoidInspection on an inspection not voided", async () => {
    serve(() => Promise.resolve(respond(200, DETAIL)));
    const holder = renderPage(["ViewFleet", "VoidInspection"]);
    expect(await screen.findByRole("button", { name: "Void inspection" })).toBeInTheDocument();
    holder.unmount();

    renderPage(["ViewFleet"]);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "Void inspection" })).toBeNull();
  });

  it("offers no void on an inspection already voided", async () => {
    serve(() =>
      Promise.resolve(
        respond(200, {
          ...DETAIL,
          inspection: { ...DETAIL.inspection, latest: false, state: "VOIDED", voidReason: "x" },
        }),
      ),
    );
    renderPage(["ViewFleet", "VoidInspection"]);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "Void inspection" })).toBeNull();
  });

  // NFR-USE-010: success is said, and the page reads the void back.
  it("closes the dialog after a void, says so, and shows the inspection voided", async () => {
    let voided = false;
    vi.mocked(fetch).mockImplementation((input) => {
      const url = requestedUrl(input);
      if (url === "/api/inspections/i1/void") {
        voided = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === PATH) {
        const inspection = voided
          ? {
              ...DETAIL.inspection,
              latest: false,
              state: "VOIDED",
              voidReason: "wrong rig",
              voidedBy: "Nomsa",
              voidedAt: "2026-11-21T10:05:00Z",
            }
          : DETAIL.inspection;
        return Promise.resolve(respond(200, { ...DETAIL, inspection }));
      }
      throw new Error(`unstubbed ${url}`);
    });
    const user = userEvent.setup();
    renderPage(["ViewFleet", "VoidInspection"]);

    await user.click(await screen.findByRole("button", { name: "Void inspection" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "wrong rig");
    await user.click(within(dialog).getByRole("button", { name: "Void inspection" }));

    expect(
      await screen.findByText(
        "Inspection voided. Its readings no longer count toward condition or exceptions.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      await screen.findByText("Voided by Nomsa on 21 Nov 2026 12:05. Reason: wrong rig."),
    ).toBeInTheDocument();
  });
});
