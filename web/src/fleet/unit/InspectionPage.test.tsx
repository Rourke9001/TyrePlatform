import { act, screen, waitFor, within } from "@testing-library/react";
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
  testQueryClient,
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

  it("counts the positions read in words that agree with the count", async () => {
    const one = { ...DETAIL, inspection: { ...DETAIL.inspection, positionsRead: 1 } };
    serve(() => Promise.resolve(respond(200, one)));
    renderPage();

    expect(await screen.findByText("1 position read on this unit")).toBeInTheDocument();
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

  // The status line is mounted empty so it speaks when the void lands, and
  // takes no room on the page until then.
  it("keeps its empty status line out of the layout", async () => {
    serve(() => Promise.resolve(respond(200, DETAIL)));
    renderPage(["ViewFleet", "VoidInspection"]);
    await screen.findByRole("heading", { level: 1 });

    const line = screen.getAllByRole("status").find((el) => el.textContent === "");
    expect(line).toBeDefined();
    expect(line).toHaveClass("tr-vh");
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

  // The void is shown when it lands, not when the page reads it back: a
  // second confirm would only meet TY019.
  it("shows the inspection voided as soon as the void lands, before the page reads it back", async () => {
    let voided = false;
    vi.mocked(fetch).mockImplementation((input) => {
      const url = requestedUrl(input);
      if (url === "/api/inspections/i1/void") {
        voided = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === PATH) {
        return voided
          ? new Promise<Response>(() => undefined)
          : Promise.resolve(respond(200, DETAIL));
      }
      throw new Error(`unstubbed ${url}`);
    });
    const user = userEvent.setup();
    renderPage(["ViewFleet", "VoidInspection"]);

    await user.click(await screen.findByRole("button", { name: "Void inspection" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "  wrong rig  ");
    await user.click(within(dialog).getByRole("button", { name: "Void inspection" }));

    expect(await screen.findByText("Voided. Reason: wrong rig.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Void inspection" })).toBeNull();
    expect(screen.queryByText("Latest inspection")).toBeNull();
  });

  // WCAG 2.4.3: the void removes the button the dialog would hand focus back
  // to, so focus goes to the page's heading, not to the body.
  it("puts focus on the page heading after a void, and back on the button after Keep it", async () => {
    let voided = false;
    vi.mocked(fetch).mockImplementation((input) => {
      const url = requestedUrl(input);
      if (url === "/api/inspections/i1/void") {
        voided = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === PATH) {
        const inspection = voided
          ? { ...DETAIL.inspection, latest: false, state: "VOIDED", voidReason: "wrong rig" }
          : DETAIL.inspection;
        return Promise.resolve(respond(200, { ...DETAIL, inspection }));
      }
      throw new Error(`unstubbed ${url}`);
    });
    const user = userEvent.setup();
    renderPage(["ViewFleet", "VoidInspection"]);

    const button = await screen.findByRole("button", { name: "Void inspection" });
    await user.click(button);
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep it" }));
    expect(button).toHaveFocus();

    await user.click(button);
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "wrong rig");
    await user.click(within(dialog).getByRole("button", { name: "Void inspection" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  it("keeps focus in the dialog when the void is refused", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = requestedUrl(input);
      if (url === "/api/inspections/i1/void") {
        return Promise.resolve(
          respond(422, { code: "TY019", message: "this inspection is already voided" }),
        );
      }
      if (url === PATH) return Promise.resolve(respond(200, DETAIL));
      throw new Error(`unstubbed ${url}`);
    });
    const user = userEvent.setup();
    renderPage(["ViewFleet", "VoidInspection"]);

    await user.click(await screen.findByRole("button", { name: "Void inspection" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "wrong rig");
    await user.click(within(dialog).getByRole("button", { name: "Void inspection" }));

    expect(
      await within(dialog).findByText("this inspection is already voided"),
    ).toBeInTheDocument();
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(screen.getByRole("heading", { level: 1 })).not.toHaveFocus();
  });

  // TY019 says the inspection stands voided, by a void of ours that timed out
  // or by someone else's, so the page reads it back and stops offering one.
  it("reads the inspection back when the void is refused as already voided", async () => {
    let refused = false;
    vi.mocked(fetch).mockImplementation((input) => {
      const url = requestedUrl(input);
      if (url === "/api/inspections/i1/void") {
        refused = true;
        return Promise.resolve(
          respond(422, { code: "TY019", message: "this inspection is already voided" }),
        );
      }
      if (url === PATH) {
        const inspection = refused
          ? {
              ...DETAIL.inspection,
              latest: false,
              state: "VOIDED",
              voidReason: "wrong tyre",
              voidedBy: "Nomsa",
              voidedAt: "2026-11-21T10:05:00Z",
            }
          : DETAIL.inspection;
        return Promise.resolve(respond(200, { ...DETAIL, inspection }));
      }
      throw new Error(`unstubbed ${url}`);
    });
    const client = testQueryClient();
    client.setQueryData(["unit-inspections", "u9"], { pages: [], pageParams: [null] });
    const user = userEvent.setup();
    renderWithActor(<InspectionPage unitId="u9" inspectionId="i1" />, {
      capabilities: ["ViewFleet", "VoidInspection"],
      withRouter: true,
      client,
    });

    await user.click(await screen.findByRole("button", { name: "Void inspection" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "wrong rig");
    await user.click(within(dialog).getByRole("button", { name: "Void inspection" }));

    expect(
      await within(dialog).findByText("this inspection is already voided"),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("Voided by Nomsa on 21 Nov 2026 12:05. Reason: wrong tyre."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Latest inspection")).toBeNull();
    expect(client.getQueryState(["unit-inspections", "u9"])?.isInvalidated).toBe(true);
  });

  // WCAG 2.4.3: the read-back removes the button the dialog would hand focus
  // back to, whether it lands before the dialog closes or after.
  it("puts focus on the page heading when a refused void's read-back removes the button", async () => {
    let refused = false;
    let release: () => void = () => undefined;
    vi.mocked(fetch).mockImplementation((input) => {
      const url = requestedUrl(input);
      if (url === "/api/inspections/i1/void") {
        refused = true;
        return Promise.resolve(
          respond(422, { code: "TY019", message: "this inspection is already voided" }),
        );
      }
      if (url === PATH) {
        if (!refused) return Promise.resolve(respond(200, DETAIL));
        const inspection = {
          ...DETAIL.inspection,
          latest: false,
          state: "VOIDED",
          voidReason: "x",
        };
        return new Promise<Response>((resolve) => {
          release = () => {
            resolve(respond(200, { ...DETAIL, inspection }));
          };
        });
      }
      throw new Error(`unstubbed ${url}`);
    });
    const user = userEvent.setup();
    renderPage(["ViewFleet", "VoidInspection"]);

    // The read-back lands while the dialog is open.
    await user.click(await screen.findByRole("button", { name: "Void inspection" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "wrong rig");
    await user.click(within(dialog).getByRole("button", { name: "Void inspection" }));
    await within(dialog).findByText("this inspection is already voided");
    act(() => {
      release();
    });
    await screen.findByText("Voided. Reason: x.");
    await user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("button", { name: "Void inspection" })).toBeNull();
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  it("puts focus on the page heading when the read-back lands after the dialog has closed", async () => {
    let refused = false;
    let release: () => void = () => undefined;
    vi.mocked(fetch).mockImplementation((input) => {
      const url = requestedUrl(input);
      if (url === "/api/inspections/i1/void") {
        refused = true;
        return Promise.resolve(
          respond(422, { code: "TY019", message: "this inspection is already voided" }),
        );
      }
      if (url === PATH) {
        if (!refused) return Promise.resolve(respond(200, DETAIL));
        const inspection = {
          ...DETAIL.inspection,
          latest: false,
          state: "VOIDED",
          voidReason: "x",
        };
        return new Promise<Response>((resolve) => {
          release = () => {
            resolve(respond(200, { ...DETAIL, inspection }));
          };
        });
      }
      throw new Error(`unstubbed ${url}`);
    });
    const user = userEvent.setup();
    renderPage(["ViewFleet", "VoidInspection"]);

    const button = await screen.findByRole("button", { name: "Void inspection" });
    await user.click(button);
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "wrong rig");
    await user.click(within(dialog).getByRole("button", { name: "Void inspection" }));
    await within(dialog).findByText("this inspection is already voided");
    await user.click(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(button).toHaveFocus();

    act(() => {
      release();
    });
    await screen.findByText("Voided. Reason: x.");
    expect(screen.getByRole("heading", { level: 1 })).toHaveFocus();
  });

  // Every unit's copy of this inspection, and no other inspection's.
  it("marks the voided inspection on every unit's page it is cached for, and no other", async () => {
    vi.mocked(fetch).mockImplementation((input) => {
      const url = requestedUrl(input);
      if (url === "/api/inspections/i1/void") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === PATH) return Promise.resolve(respond(200, DETAIL));
      throw new Error(`unstubbed ${url}`);
    });
    const client = testQueryClient();
    const other = { ...DETAIL, inspection: { ...DETAIL.inspection, inspectionId: "i2" } };
    client.setQueryData(["unit-inspection", "h12", "i1"], DETAIL);
    client.setQueryData(["unit-inspection", "u9", "i2"], other);
    const user = userEvent.setup();
    renderWithActor(<InspectionPage unitId="u9" inspectionId="i1" />, {
      capabilities: ["ViewFleet", "VoidInspection"],
      withRouter: true,
      client,
    });

    await user.click(await screen.findByRole("button", { name: "Void inspection" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "wrong rig");
    await user.click(within(dialog).getByRole("button", { name: "Void inspection" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    const sibling = client.getQueryData<InspectionDetail>(["unit-inspection", "h12", "i1"]);
    expect(sibling?.inspection.state).toBe("VOIDED");
    expect(sibling?.inspection.voidReason).toBe("wrong rig");
    expect(sibling?.inspection.latest).toBe(false);
    const untouched = client.getQueryData<InspectionDetail>(["unit-inspection", "u9", "i2"]);
    expect(untouched?.inspection.state).toBe("SYNCED");
  });

  // A failed refresh keeps what was loaded, as the inspection list keeps its
  // rows (web/CLAUDE.md, The network).
  it("keeps the inspection and the void's word through a refresh that fails, and retries", async () => {
    let failing = false;
    vi.mocked(fetch).mockImplementation((input) => {
      const url = requestedUrl(input);
      if (url === "/api/inspections/i1/void") {
        failing = true;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (url === PATH) return Promise.resolve(failing ? respond(500, {}) : respond(200, DETAIL));
      throw new Error(`unstubbed ${url}`);
    });
    const user = userEvent.setup();
    renderPage(["ViewFleet", "VoidInspection"]);

    await user.click(await screen.findByRole("button", { name: "Void inspection" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByRole("textbox", { name: "Reason" }), "wrong rig");
    await user.click(within(dialog).getByRole("button", { name: "Void inspection" }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("This inspection couldn't be refreshed");
    expect(screen.queryByText("Inspection didn't load")).toBeNull();
    expect(
      screen.getByText(
        "Inspection voided. Its readings no longer count toward condition or exceptions.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Readings" })).toBeInTheDocument();

    failing = false;
    await user.click(within(notice).getByRole("button", { name: "Retry" }));
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect(screen.getByRole("region", { name: "Readings" })).toBeInTheDocument();
  });

  // A 404 answers the same next time, so it stands over the copy in hand.
  it("says an inspection no longer on this unit is not, over the copy it had loaded", async () => {
    let gone = false;
    serve(() =>
      Promise.resolve(
        gone
          ? respond(404, { code: "not_found", message: "no such inspection" })
          : respond(200, DETAIL),
      ),
    );
    const client = testQueryClient();
    renderWithActor(<InspectionPage unitId="u9" inspectionId="i1" />, {
      capabilities: ["ViewFleet"],
      withRouter: true,
      client,
    });
    await screen.findByRole("heading", { level: 1 });

    gone = true;
    await act(() => client.refetchQueries());
    expect(await screen.findByText("This inspection is not on this unit.")).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Readings" })).toBeNull();
  });
});
