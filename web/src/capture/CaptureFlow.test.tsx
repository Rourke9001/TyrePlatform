import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import { focusManager, onlineManager, type QueryClient } from "@tanstack/react-query";
import userEvent, { type UserEvent } from "@testing-library/user-event";

import { clearDevActorId, setDevActorId } from "../api/devTenant";
import { renderWithActor, testQueryClient } from "../test/fixtures";
import { expectNothingForbiddenSpoken } from "../test/spoken";
import { CaptureFlow } from "./CaptureFlow";
import type { CaptureContext } from "./captureContext";
import { captureContextQuery } from "./captureContext";
import { clearDraft, db, loadDraft, markSpareAbsent, startDraft } from "./draft";
import { listOutbox } from "./outbox";

const DRIVER = "oid-driver-1";

// CaptureFlow uses useCaptureContext -> useQuery, so an unwrapped render
// throws before any assertion runs. retry:false matters too: the default
// three retries would make the "refuses to start" test wait them out.
function renderFlow() {
  return renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />);
}

// One position, so the flow reaches review in a handful of clicks. Copy the
// full shape from captureContext.test.ts; only the parts the flow reads are
// spelled out here.
const context: CaptureContext = {
  vehicleId: "v1",
  fleetNumber: "BAC039SP",
  registration: "BAC039SP",
  unitKind: "HORSE",
  lastOdometerKm: 412180,
  lastOdometerAt: "2026-08-19T06:00:00Z",
  averageDailyKm: null,
  combination: null,
  positions: [
    {
      id: "p1",
      vehicleId: "v1",
      code: "1",
      sequence: 1,
      axleClass: "STEER",
      axleType: "FIXED",
      side: "LEFT",
      axleNumber: 1,
      isSpare: false,
      unitLabel: "Horse",
      tyreId: "ty1",
      tyreCode: "BAC-04217",
      previousGoverningMm: 14,
      previousReadingAt: "2026-07-23T06:00:00Z",
      fitmentSincePrevious: false,
      targetKpa: 800,
      warnUnderPct: 10,
      criticalUnderPct: 20,
      warnOverPct: 10,
      criticalOverPct: 20,
    },
  ],
  config: {
    treadReadingCount: 3,
    treadGranularityMm: 1.0,
    widthSpreadWarnMm: 4,
    odometerMaxDailyKm: 1600,
    wearRateAlertMultiple: 3,
    removalThresholdMm: 4,
    captureSpares: true,
  },
  cohortWearRateMmPerMonth: { "STEER:FIXED": 0.8 },
};

// The active-cell assertion below is vacuous on a one-position rig: "no other
// cell is marked" needs another cell to exist.
const twoPositions: CaptureContext = {
  ...context,
  positions: [context.positions[0], { ...context.positions[0], id: "p2", code: "2", sequence: 2 }],
};

// A rig: what a CONTROLLER coupled up, pre-ticked for the driver to confirm
// (FR-INS-062). The trailer's two positions are what make the completeness
// denominator below distinguishable from the motive unit's own count.
const rigMotive: CaptureContext = {
  ...context,
  combination: {
    id: "c1",
    members: [
      { vehicleId: "v1", fleetNumber: "BAC039SP", sequence: 1, descriptor: "Horse" },
      { vehicleId: "v2", fleetNumber: "BAC711TR", sequence: 2, descriptor: "Link 1" },
    ],
  },
};

const trailer: CaptureContext = {
  ...context,
  vehicleId: "v2",
  fleetNumber: "BAC711TR",
  unitKind: "TRAILER",
  lastOdometerKm: null,
  lastOdometerAt: null,
  combination: null,
  // The SAME position ids as the motive unit, deliberately. app.position rows
  // belong to an axle configuration and not to a vehicle, so two like units on
  // one rig share every id. The register cannot produce the distinct-id shape,
  // and a fixture that used one would let a collision between units pass
  // unseen while looking like better coverage.
  positions: [
    { ...context.positions[0], vehicleId: "v2", code: "1", sequence: 1 },
    { ...context.positions[0], id: "p2", vehicleId: "v2", code: "2", sequence: 2 },
  ],
};

// TYRE-155: one running position plus one spare, so the flow's own advance
// lands the driver on the spare sheet the moment the running position is
// done. The "no spare" tap is then the one action left before review.
const withSpare: CaptureContext = {
  ...context,
  positions: [
    context.positions[0],
    {
      ...context.positions[0],
      id: "s1",
      code: "S",
      sequence: 99,
      isSpare: true,
      axleClass: "SPARE",
      side: null,
      axleNumber: null,
      targetKpa: null,
    },
  ],
};

// One position, and it is the spare, so a draft on this unit can hold an
// absent-spare mark with nothing captured at all, which is exactly the case
// lostWords has to name rather than read as empty (TYRE-146).
const spareOnly: CaptureContext = {
  ...context,
  positions: [
    {
      ...context.positions[0],
      id: "s1",
      code: "S",
      sequence: 1,
      isSpare: true,
      axleClass: "SPARE",
      side: null,
      axleNumber: null,
      targetKpa: null,
    },
  ],
};

// GET the context of whichever unit was asked for, POST the inspection. Routed
// on method and on the vehicle in the path, so neither the order the component
// calls in nor which unit it asks for first decides whether the test passes.
function stubApi(
  submitStatus = 201,
  served: CaptureContext[] = [context],
  submitCode: string | null = null,
) {
  const byId = new Map(served.map((c) => [c.vehicleId, c]));
  const api = vi.fn((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      const reply =
        submitStatus < 400 ? { inspectionId: "i1" } : { code: submitCode, message: "refused" };
      return Promise.resolve({
        ok: submitStatus < 400,
        status: submitStatus,
        json: () => Promise.resolve(reply),
        text: () => Promise.resolve(JSON.stringify(reply)),
      });
    }
    const asked = byId.get(url.split("?")[0].split("/").pop() ?? "");
    return Promise.resolve(
      asked
        ? { ok: true, status: 200, json: () => Promise.resolve(asked) }
        : {
            ok: false,
            status: 404,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve(JSON.stringify({})),
          },
    );
  });
  vi.stubGlobal("fetch", api);
  return api;
}

// Every capture context GET the flow made, in order.
function contextReads(api: ReturnType<typeof stubApi>): string[] {
  return api.mock.calls
    .filter(([url, init]) => init?.method !== "POST" && url.startsWith("/api/capture/vehicles/"))
    .map(([url]) => url);
}

// Real timers throughout: CaptureFlow writes to IndexedDB on every keystroke
// (FR-OFF-005) and Dexie completes on a real setTimeout, so fake timers
// deadlock every write (docs/lessons.md, "Fake timers deadlock IndexedDB").
// Each step waits for the settle's own effect (aria-current), not a tick count.
async function capturePosition(user: UserEvent) {
  await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));

  const treads = [
    ["1", "3"],
    ["1", "3"],
    ["1", "4"],
  ];
  for (let i = 0; i < treads.length; i++) {
    for (const d of treads[i]) {
      await user.click(screen.getByRole("button", { name: d }));
    }
    const next = i + 1 < treads.length ? `Tread reading ${i + 2} of ${treads.length}` : "Pressure";
    await waitFor(() =>
      expect(screen.getByLabelText(next)).toHaveAttribute("aria-current", "true"),
    );
  }

  for (const d of ["8", "0", "0"]) {
    await user.click(screen.getByRole("button", { name: d }));
  }
  // A position with nothing to flag finishes off the pressure field; a
  // warned one waits for the FR-INS-040 response tap. Either way the open
  // sheet must go: next outstanding, or back to the diagram.
  const answer = screen.queryByRole("button", { name: /seen it ›/i });
  if (answer) await user.click(answer);
  await waitFor(() =>
    expect(screen.queryByRole("button", { name: /done ›|seen it ›/i })).toBeNull(),
  );
}

beforeEach(async () => {
  await db.open();
  await clearDraft();
  // A permanently refused entry is left in the queue on purpose (FR-OFF-013),
  // so without this the 409 test's own leftover decides the next test's count.
  await db.table("outbox").clear();
  setDevActorId(DRIVER);
});

afterEach(async () => {
  clearDevActorId();
  vi.unstubAllGlobals();
  // The storage-failure tests spy on Dexie's own methods; a leaked spy would
  // fail the next block somewhere with no connection to its cause.
  vi.restoreAllMocks();
  await clearDraft();
  await db.table("outbox").clear();
});

const newUser = () => userEvent.setup();

describe("CaptureFlow", () => {
  // NFR-AVL-002: starting requires the server. A driver must not start
  // against reference data that never arrived, or every threshold is
  // missing and every warning silently never fires.
  it("refuses to start when the reference data has not loaded", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderFlow();

    expect(await screen.findByRole("alert")).toHaveTextContent(/connect|signal|load/i);
    expect(screen.queryByRole("button", { name: /start inspection/i })).toBeNull();
    // The storage alert's own retry can render at the same time (see the
    // stacked test below), so this one has to name its own action.
    expect(screen.getByRole("button", { name: /reload vehicle/i })).toBeInTheDocument();
  });

  // NFR-USE-010: success is stated, not implied.
  it("confirms a submitted inspection in words", async () => {
    const user = newUser();
    stubApi(201);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    expect(await screen.findByRole("status")).toHaveTextContent(/sent|recorded/i);
  });

  // FR-OFF-013 and FR-OFF-014 together: a permanent refusal is presented with
  // something to act on, and the readings are still on the device.
  it("presents a duplicate-window refusal without losing the inspection", async () => {
    const user = newUser();
    stubApi(409, [context], "TY003");
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already inspected/i);
    expect(await db.table("outbox").count()).toBe(1);
  });

  // FR-INS-038's window is the one refusal a driver resolves by naming that
  // vehicle to the office; naming the wrong one sends them to argue about an
  // inspection that never happened (NFR-USE-005).
  it("does not blame the duplicate window for an unrelated conflict", async () => {
    const user = newUser();
    stubApi(409, [context], "conflict");
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/could not accept/i);
    expect(alert).not.toHaveTextContent(/already inspected/i);
    expect(await db.table("outbox").count()).toBe(1);
  });

  // NFR-USE-011/FR-OFF-006: a remount is a reload and finds the work with
  // its numbers, not just its progress. This one stays on the diagram since
  // its one position is already complete.
  it("resumes an in-progress inspection after a remount", async () => {
    const user = newUser();
    stubApi();
    const { unmount } = renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    unmount();

    renderFlow();
    await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));
    expect(within(screen.getByLabelText(/Tread reading 1 of 3/)).getByText("13")).toBeVisible();
  });

  // U148: a resumed draft reads its units through the window its submit is
  // judged over, so a trip that ended while it sat on the phone does not
  // strand it. Every read waits for the draft load, so none goes at now.
  it("reads a resumed draft's units through the draft's own startedAt", async () => {
    const startedAt = "2026-10-22T06:00:00.000Z";
    await startDraft({
      driverSubject: DRIVER,
      vehicleId: "v1",
      taskId: null,
      startedAt,
      fleetNumber: "BAC039SP",
      combinationId: "c1",
      observedMemberVehicleIds: ["v1", "v2"],
    });
    const api = stubApi(201, [rigMotive, trailer]);
    renderFlow();

    await screen.findAllByRole("button", { name: /, BAC711TR, / });
    const reads = contextReads(api);
    expect(reads.map((u) => u.split("?")[0]).sort()).toEqual([
      "/api/capture/vehicles/v1",
      "/api/capture/vehicles/v2",
    ]);
    for (const u of reads) expect(u).toContain(`?startedAt=${encodeURIComponent(startedAt)}`);
  });

  // FR-OFF-001, rule 7: a remount reads through the draft's startedAt, a key
  // the first mount never cached. Offline the query pauses, so without a seed
  // from the at-now entry the capture sticks on "Loading…" until signal.
  it.each([
    ["a solo unit", [context], /^Position 1,/],
    ["a rig", [rigMotive, trailer], /, BAC711TR, /],
  ])(
    "remounts %s offline on the cached context",
    async (_name, served, cell) => {
      const user = newUser();
      stubApi(201, served);
      const client = testQueryClient();
      const mount = () => renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, { client });

      const first = mount();
      await user.click(await screen.findByRole("button", { name: /start inspection/i }));
      await screen.findAllByRole("button", { name: cell });
      first.unmount();

      onlineManager.setOnline(false);
      try {
        mount();
        await screen.findAllByRole("button", { name: cell });
        expect(screen.queryByText("Loading…")).toBeNull();
      } finally {
        onlineManager.setOnline(true);
      }
    },
    20000,
  );

  it("reads a fresh capture's unit at now", async () => {
    const api = stubApi();
    renderFlow();

    await screen.findByRole("button", { name: /start inspection/i });
    expect(contextReads(api)).toEqual(["/api/capture/vehicles/v1"]);
  });

  it("asks for nothing until the draft has loaded", async () => {
    const api = stubApi();
    let release: (v: undefined) => void = () => undefined;
    const held = new Promise<undefined>((resolve) => (release = resolve));
    const get = vi.spyOn(db.drafts, "get").mockReturnValue(held as never);
    renderFlow();

    await waitFor(() => expect(get).toHaveBeenCalled());
    expect(contextReads(api)).toEqual([]);
    release(undefined);
    await screen.findByRole("button", { name: /start inspection/i });
    expect(contextReads(api)).toEqual(["/api/capture/vehicles/v1"]);
  });

  // FR-OFF-001: the signal can go once the context has loaded, and
  // capture.spec.ts cuts it at exactly this point. Start must not change
  // the read's key, or the capture screen waits on a fetch that cannot land.
  it("makes no further read after Start, and captures with the network gone", async () => {
    const user = newUser();
    const api = stubApi();
    renderFlow();

    await screen.findByRole("button", { name: /start inspection/i });
    api.mockImplementation(() => Promise.reject(new TypeError("Failed to fetch")));
    await user.click(screen.getByRole("button", { name: /start inspection/i }));

    expect(await screen.findByRole("button", { name: /^Position 1,/ })).toBeInTheDocument();
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(contextReads(api)).toEqual(["/api/capture/vehicles/v1"]);
  });

  // TYRE-148, the other half: resume put the driver on the diagram (one tap
  // to reopen) even when the draft says exactly which sheet they were in.
  it("resumes straight into the position that was half-entered", async () => {
    const user = newUser();
    stubApi(201, [twoPositions]);
    const { unmount } = renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await user.click(await screen.findByRole("button", { name: /^Position 2,/ }));
    await user.click(screen.getByRole("button", { name: "9" }));
    await waitFor(async () => expect((await loadDraft())?.positions["v1:p2"]?.treads[0]).toBe(9));
    unmount();

    renderFlow();
    const sheet = await screen.findByRole("region", { name: "Position 2" });
    expect(sheet).toBeInTheDocument();
    expect(screen.getByLabelText(/Tread reading 2 of 3/)).toHaveAttribute("aria-current", "true");
  });

  // The diagram's active mark is the driver's place-keeper. Marking every
  // cell satisfies "the open one is marked" as well as marking one, so the
  // assertion is on the whole set.
  it("marks the open position on the diagram and no other", async () => {
    const user = newUser();
    stubApi(201, [twoPositions]);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));

    const cells = Array.from(document.querySelectorAll<HTMLElement>("[data-position-id]"));
    expect(cells).toHaveLength(2);
    expect(
      cells.filter((c) => c.dataset.active === "true").map((c) => c.dataset.positionId),
    ).toEqual(["p1"]);
  });

  // WCAG 2.4.11: the sheet's layer is opaque over the whole screen, so
  // nothing it covers may take focus while a position is open. jsdom and
  // user-event ignore inert, so this pins the attribute; e2e/sheetFit.spec.ts
  // presses Shift+Tab in a browser.
  it("leaves nothing the open sheet covers able to take focus, and frees it on close", async () => {
    const user = newUser();
    stubApi();
    // Stands in for the shell's bar, which CaptureFlow does not render.
    const shellBar = document.body.appendChild(document.createElement("button"));
    shellBar.textContent = "Back";
    try {
      renderFlow();
      await user.click(await screen.findByRole("button", { name: /start inspection/i }));
      await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));

      const layer = document.querySelector(".cap-sheet-layer");
      expect(layer).not.toBeNull();
      const focusable = Array.from(
        document.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea"),
      );
      const outside = focusable.filter((el) => !layer?.contains(el));
      expect(outside.map((el) => el.textContent)).toContain("Discard this inspection");
      expect(outside).toContain(shellBar);
      expect(outside.filter((el) => el.closest("[inert]") === null)).toEqual([]);
      expect(focusable.filter((el) => layer?.contains(el) && el.closest("[inert]"))).toEqual([]);

      await user.click(screen.getByRole("button", { name: "Close" }));
      await waitFor(() => expect(document.querySelector(".cap-sheet-layer")).toBeNull());
      expect(document.querySelectorAll("[inert]")).toHaveLength(0);
    } finally {
      shellBar.remove();
    }
  });

  // app.inspection.completeness_pct defaults to 100 (NFR-PRO-003), so a
  // submit without it is recorded complete. The denominator is every
  // position on every confirmed unit (FR-INS-065), a rig not the motive
  // unit alone.
  it("counts every unit on the rig in the completeness it reports", async () => {
    const user = newUser();
    const api = stubApi(201, [rigMotive, trailer]);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    // Two positions are still outstanding, so finishing the first opened the
    // next one over the diagram (.cap-sheet-layer covers it). Review is
    // reachable only from the diagram, which is where a driver who stops
    // short of a full rig has to close the sheet to get to.
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    expect(screen.getByText(/1 of 3 positions done/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));
    await screen.findByRole("status");

    const posted = api.mock.calls.find(([, init]) => init?.method === "POST")?.[1];
    const body = JSON.parse(String(posted?.body)) as {
      completeness_pct: number;
      combination_id: string | null;
      observed_member_vehicle_ids: string[];
      readings: unknown[];
    };
    expect(body.readings).toHaveLength(1);
    expect(body.completeness_pct).toBe(33);
    // FR-INS-062/063: the composition the driver confirmed, motive unit
    // included, travels as an observation for a controller to reconcile.
    expect(body.combination_id).toBe("c1");
    expect(body.observed_member_vehicle_ids).toEqual(["v1", "v2"]);
  });

  // NFR-USE-001a: finishing a position opens the next outstanding one so the
  // driver pays one tap per walk, not one plus a re-orientation. Both rig
  // units carry ids p1/p2 (BR-VEH-003, draft.cellKey), so "next outstanding"
  // must ask by cell.
  it("opens the next outstanding position on the next unit rather than stepping over it", async () => {
    const user = newUser();
    stubApi(201, [rigMotive, trailer]);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);

    const sheet = await screen.findByRole("region", { name: "Position 2" });
    expect(sheet).toHaveTextContent("BAC711TR");
    expect(screen.getByLabelText("Pressure")).toHaveTextContent("–");
  });

  // Swept at every stage, not once at the end: start and capture unmount
  // before review renders, so a single end-of-test sweep would look like it
  // guarded all four screens while guarding one.
  it("never says legal, roadworthy, statutory or minimum to a driver, on any screen", async () => {
    const user = newUser();
    stubApi(201);
    const { container } = renderFlow();

    await screen.findByRole("button", { name: /start inspection/i });
    expectNothingForbiddenSpoken(container, /start inspection/);

    await user.click(screen.getByRole("button", { name: /start inspection/i }));
    await screen.findByRole("button", { name: /^Position 1,/ });
    expectNothingForbiddenSpoken(container, /position 1/);

    await capturePosition(user);
    expectNothingForbiddenSpoken(container, /review and submit/);

    // The entry sheet, reopened. FR-INS-029a's whole risk lives in these
    // labels, and they exist only as aria-labels.
    await user.click(screen.getByRole("button", { name: /^Position 1,/ }));
    expectNothingForbiddenSpoken(container, /tread reading 1 of 3/);
    await user.click(screen.getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    expectNothingForbiddenSpoken(container, /submit inspection/);

    await user.click(screen.getByRole("button", { name: /submit inspection/i }));
    await screen.findByRole("status");
    expectNothingForbiddenSpoken(container, /inspection sent/);
  });

  // FR-OFF-014/NFR-USE-005: IndexedDB can throw outright (private window,
  // MDM policy). The driver's Start button can never work, so the alert must
  // sit above the screen switch, not inside one branch.
  it("refuses to start when the device cannot store anything, and names a way out", async () => {
    stubApi(201);
    vi.spyOn(db.drafts, "get").mockRejectedValue(new Error("storage blocked"));
    renderFlow();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/cannot be started/i);
    // The mid-inspection sentence is the one thing this screen must NOT say:
    // there is no inspection to keep open, so it is an instruction that
    // cannot be followed, which NFR-USE-005 rates below saying nothing.
    expect(alert).not.toHaveTextContent(/keep the app open/i);
    expect(screen.getByRole("button", { name: /recheck storage/i })).toBeInTheDocument();
    // The read starts once the draft load has answered (U148), so the
    // button follows the alert.
    expect(await screen.findByRole("button", { name: /start inspection/i })).toBeDisabled();
  });

  // The retry has to re-attempt, not just clear the message. A device policy
  // or a private window is changed by a person, and this is the tap that picks
  // the change up (FR-OFF-013's supported recovery action).
  it("starts working again when storage returns and the driver retries", async () => {
    const user = newUser();
    stubApi(201);
    const blocked = vi.spyOn(db.drafts, "get").mockRejectedValue(new Error("storage blocked"));
    renderFlow();
    await screen.findByRole("alert");

    blocked.mockRestore();
    await user.click(screen.getByRole("button", { name: /recheck storage/i }));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: /start inspection/i })).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // Proves the retry re-attempts rather than clearing the message: a retry
  // that only hid the banner would leave an enabled Start with no warning,
  // exactly where this round started.
  it("says so again when a retry finds the device still refusing", async () => {
    const user = newUser();
    stubApi(201);
    vi.spyOn(db.drafts, "get").mockRejectedValue(new Error("storage blocked"));
    renderFlow();
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: /recheck storage/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be started/i);
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeDisabled();
  });

  // The other pre-start route to the same standing refusal: the read
  // succeeded, so nothing warned, and the write is what the device blocks.
  it("refuses to start when the draft itself cannot be written", async () => {
    const user = newUser();
    stubApi(201);
    vi.spyOn(db.drafts, "put").mockRejectedValue(new Error("storage blocked"));
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/cannot be started/i);
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeDisabled();
  });

  // The storage alert (hoisted) and the context-fetch failure (inside the
  // switch) can both render at once; asserts the two retry names differ,
  // not just that two buttons exist.
  it("names each retry by what it retries when storage and the context fetch both fail", async () => {
    stubApi(201, []); // nothing served: every GET 404s, so motive.isError becomes true
    vi.spyOn(db.drafts, "get").mockRejectedValue(new Error("storage blocked"));
    renderFlow();

    const reloadVehicle = await screen.findByRole("button", { name: /reload vehicle/i });
    const recheckStorage = await screen.findByRole("button", { name: /recheck storage/i });
    expect(reloadVehicle.textContent).not.toBe(recheckStorage.textContent);
  });

  // The same alert on the other screen that could not show it. A submit that
  // throws re-enables the button and leaves the driver on review, so without
  // this they tap the most important control in the app and observe nothing.
  it("says so on the review screen when the submit cannot be written", async () => {
    const user = newUser();
    stubApi(201);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));

    // Installed only now: the capture above has to reach the draft normally.
    vi.spyOn(db.drafts, "put").mockRejectedValue(new Error("storage blocked"));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    // The mid-inspection wording, not the standing refusal: the readings are
    // on screen and the submit path may still work, so this must not tell the
    // driver the inspection cannot be started.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/keep the app open/i);
    expect(alert).not.toHaveTextContent(/cannot be started/i);
    expect(screen.queryByRole("button", { name: /recheck storage/i })).toBeNull();
    // Still on review, with the readings on screen and the button live again.
    expect(screen.getByRole("button", { name: /submit inspection/i })).toBeEnabled();
  });

  // The defect: a position with treads read and no pressure was banded
  // "Not done" (000023 accepts NULL pressure), hiding FR-INS-036 on a cell
  // the app had every number for.
  it("bands a tread-complete position with no pressure, and counts it done", async () => {
    const user = newUser();
    stubApi(201);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));

    // 3mm does not settle the field, another digit still fits under 35mm, so
    // the go key is what moves it on; 4mm does.
    for (const d of ["3", "3"]) {
      await user.click(screen.getByRole("button", { name: d }));
      await user.click(screen.getByRole("button", { name: /next ›/i }));
    }
    await user.click(screen.getByRole("button", { name: "4" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Pressure")).toHaveAttribute("aria-current", "true"),
    );
    expect(screen.getByLabelText("Pressure")).toHaveTextContent("–");
    await user.click(screen.getByRole("button", { name: "Close" }));

    expect(
      await screen.findByRole("button", { name: "Position 1, BAC039SP, Report, axle 1, left" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "1 of 1 done" })).toBeInTheDocument();
  });

  // FR-OFF-014: the outbox is not a place work goes to be forgotten. A queued
  // entry that the server has not taken is still the driver's inspection.
  it("keeps a refused inspection queued rather than discarding it", async () => {
    const user = newUser();
    stubApi(409);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));
    await screen.findByRole("alert");

    const [entry] = await listOutbox();
    expect(entry.state).toBe("failed");
    expect(entry.payload.readings).toHaveLength(1);
    expect(entry.payload.readings[0].treads).toEqual([13, 13, 14]);
  });

  // TYRE-146 (Critical): a driver who Starts the wrong truck and captures
  // nothing had no exit. The discard is that exit, and it names what is
  // lost.
  it("lets a driver discard the other vehicle's inspection and start this one", async () => {
    const user = newUser();
    stubApi();
    await startDraft({
      driverSubject: DRIVER,
      vehicleId: "v-wrong",
      taskId: null,
      startedAt: new Date().toISOString(),
      fleetNumber: "BAC711TR",
    });
    const { container } = renderFlow();

    expect(await screen.findByRole("alert")).toHaveTextContent(/another vehicle/i);
    await user.click(screen.getByRole("button", { name: /discard it/i }));
    expect(screen.getByRole("group", { name: /BAC711TR/ })).toHaveTextContent(
      /no positions captured|0 captured positions/i,
    );
    await user.click(screen.getByRole("button", { name: "Discard" }));

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    expect((await loadDraft())?.vehicleId).toBe("v1");
    expectNothingForbiddenSpoken(container, /discard/i);
  });

  it("names the vehicle and the positions lost before discarding from the capture screen", async () => {
    const user = newUser();
    stubApi();
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /discard this inspection/i }));
    const panel = screen.getByRole("group", { name: /BAC039SP/ });
    expect(panel).toHaveTextContent(/1 captured position\b/);

    // Keep it: nothing moves, the draft is intact.
    await user.click(screen.getByRole("button", { name: "Keep it" }));
    expect((await loadDraft())?.vehicleId).toBe("v1");
    expect(screen.getByRole("heading", { name: /1 of 1 done/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /discard this inspection/i }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(await screen.findByRole("button", { name: /start inspection/i })).toBeInTheDocument();
    expect(await loadDraft()).toBeUndefined();
  });

  // TYRE-146: a draft whose only observation is "No spare on this unit" had
  // zero captured positions, so the old wording read it as empty right
  // before clearDraft discarded the mark too.
  it("names a lost absent-spare mark when the draft has no captured positions", async () => {
    const user = newUser();
    stubApi(201, [spareOnly]);
    await startDraft({
      driverSubject: DRIVER,
      vehicleId: "v1",
      taskId: null,
      startedAt: new Date().toISOString(),
      fleetNumber: "BAC039SP",
    });
    await markSpareAbsent("v1", "s1");
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /discard this inspection/i }));
    const panel = screen.getByRole("group", { name: /BAC039SP/ });
    expect(panel).toHaveTextContent(/1 "No spare" mark will be lost\./);
    expect(panel).not.toHaveTextContent(/captured position/);
  });

  // TYRE-155 end to end on the flow: the spare cell leaves the count, the
  // review reads all done, the payload carries the observation, and the
  // driver paid one tap, the same one they paid to close the sheet before.
  it("reports a unit done when its spare is marked absent, and sends the observation", async () => {
    const user = newUser();
    const api = stubApi(201, [withSpare]);
    const { container } = renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user); // opens the spare next, by the flow's own advance
    await user.click(await screen.findByRole("button", { name: /no spare on this unit/i }));

    expect(await screen.findByRole("heading", { name: /1 of 1 done/ })).toBeInTheDocument();
    expectNothingForbiddenSpoken(container, /1 of 1 done/);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));
    await screen.findByRole("status");

    const posted = api.mock.calls.find(([, init]) => init?.method === "POST")?.[1];
    const body = JSON.parse(String(posted?.body)) as {
      completeness_pct: number;
      absent_spares: { vehicle_id: string; position_id: string }[];
    };
    expect(body.completeness_pct).toBe(100);
    expect(body.absent_spares).toEqual([{ vehicle_id: "v1", position_id: "s1" }]);
  });

  it("renders no spare cell for a tenant that does not capture spares", async () => {
    const user = newUser();
    stubApi(201, [{ ...withSpare, config: { ...withSpare.config, captureSpares: false } }]);
    const { container } = renderFlow();
    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    expect(await screen.findByRole("heading", { name: /0 of 1 done/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Spare/ })).toBeNull();
    expectNothingForbiddenSpoken(container, /0 of 1 done/);
  });
});

describe("sign-in inside capture", () => {
  // "No subject, no draft" (U104).
  it("refuses to start without a known driver and asks for a sign-in", async () => {
    clearDevActorId();
    stubApi();
    const user = newUser();
    renderFlow();
    await user.click(await screen.findByRole("button", { name: /start inspection/i }));

    expect(await screen.findByText("Sign in before you start an inspection.")).toBeInTheDocument();
    expect(await loadDraft()).toBeUndefined();
    expect(screen.queryByText(/not letting the app save/)).toBeNull();
  });

  it("says to sign in, not to find signal, when loading the vehicle answers 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ code: "unauthorized", message: "x" }),
          text: () => Promise.resolve(JSON.stringify({ code: "unauthorized", message: "x" })),
        }),
      ),
    );
    renderFlow();
    expect(await screen.findByText("Sign in to load this vehicle.")).toBeInTheDocument();
    expect(screen.queryByText(/Find signal/)).toBeNull();
  });

  // U104: callback.ts lets a sign-in through when the stamp read fails, so the
  // draft itself must not resume under anyone else. Nothing is discarded,
  // because that is an explicit act (FR-OFF-014).
  it("does not resume a draft another driver started, and discards nothing", async () => {
    await startDraft({
      driverSubject: "oid-other",
      vehicleId: "v1",
      taskId: null,
      startedAt: "2026-09-30T06:00:00Z",
    });
    stubApi();
    renderFlow();

    expect(
      await screen.findByText(/Another driver has an inspection open on this phone/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /start inspection|discard/i })).toBeNull();
    // A way off the screen for whoever holds the phone.
    expect(screen.getByRole("link", { name: "My inspections" })).toHaveAttribute("href", "/my");
    expect((await loadDraft())?.driverSubject).toBe("oid-other");
  });
});

// TYRE-329, NFR-USE-005: a refusal answers the same on every reload, so it
// says what happened and who can change it, and offers no reload. Only a
// fault that signal can clear keeps the signal line and its button.
describe("a vehicle that does not load", () => {
  // A real Response: the client reads a refusal's body as text (TYRE-389).
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  // Every GET fails with this status, or, given a motive, every GET but v1's.
  function answer(status: number, code: string, motive?: CaptureContext) {
    const fetch = vi.fn((url: string) =>
      Promise.resolve(
        motive !== undefined && url.split("?")[0].endsWith("/v1")
          ? json(200, motive)
          : json(status, { code, message: "x" }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it.each([
    [
      "forbidden",
      "You do not have permission to inspect this vehicle. Ask your fleet office to check you are assigned to it.",
    ],
    ["tenant_inactive", "This company's account is not active. Contact your fleet office."],
    ["not_provisioned", "Ask your fleet office to set up your account."],
  ])("says why a 403 %s refuses it, with nothing to reload", async (code, sentence) => {
    answer(403, code);
    renderFlow();

    expect((await screen.findByRole("alert")).textContent).toBe(sentence);
    expect(screen.queryByRole("button", { name: /reload vehicle/i })).toBeNull();
    expect(screen.queryByText(/Find signal/)).toBeNull();
    expect(screen.getByRole("link", { name: "My inspections" })).toHaveAttribute("href", "/my");
  });

  // The member units load on the start screen, whose own branch comes
  // first, so one that fails is told after Start, beside the saved draft.
  it("says why a rig member's 403 refuses it, not signal", async () => {
    answer(403, "forbidden", rigMotive);
    renderFlow();

    await newUser().click(await screen.findByRole("button", { name: /start inspection/i }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "You do not have permission to inspect a unit on this rig. Ask your fleet office to check you are assigned to it. Your readings are saved.",
    );
    expect(screen.queryByText(/Find signal/)).toBeNull();
    expect(screen.getByRole("link", { name: "My inspections" })).toHaveAttribute("href", "/my");
  });

  it("says to sign in, not to find signal, when a rig member answers 401", async () => {
    answer(401, "unauthorized", rigMotive);
    renderFlow();

    await newUser().click(await screen.findByRole("button", { name: /start inspection/i }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign in to load the rest of the rig. Your readings are saved.",
    );
    expect(screen.getByRole("button", { name: "Reload rig" })).toBeInTheDocument();
  });

  // Loading waits only on a copy that is renewing. A member still loading
  // for the first time does not hold the start screen back.
  it("shows the start screen while a rig member first loads", async () => {
    // The member's GET never answers, so it stays on its first load.
    const hang = new Promise<Response>((resolve) => void resolve);
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        url.split("?")[0].endsWith("/v1") ? Promise.resolve(json(200, rigMotive)) : hang,
      ),
    );
    renderFlow();

    expect(await screen.findByRole("button", { name: /start inspection/i })).toBeInTheDocument();
  });

  // A failed query is fetched again only by a mount, focus or reconnect, so
  // the screen that says try again offers the try.
  it("reloads a rig member that failed with a 500", async () => {
    const user = newUser();
    const fetch = answer(500, "internal", rigMotive);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load the rest of the rig. Find signal and try again. Your readings are saved.",
    );

    fetch.mockImplementation((url: string) =>
      Promise.resolve(json(200, url.split("?")[0].endsWith("/v1") ? rigMotive : trailer)),
    );
    await user.click(screen.getByRole("button", { name: "Reload rig" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it.each([
    ["a 500", () => answer(500, "internal")],
    [
      "a network fault",
      () => vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch"))),
    ],
  ])("keeps the signal line and the reload for %s", async (_, fail) => {
    fail();
    renderFlow();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Could not load this vehicle. Find signal and try again.",
    );
    expect(screen.getByRole("button", { name: "Reload vehicle" })).toBeInTheDocument();
  });

  // A 503 auth_unavailable is the token store's latch, which only a page
  // reload clears (apiError.ts), so a Reload that refetches into it is no way
  // out, and signal is not the cause.
  it("says sign-in is unavailable, with a page reload, for a latched store", async () => {
    answer(503, "auth_unavailable");
    renderFlow();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign-in is unavailable right now. Try again shortly.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload vehicle" })).toBeNull();
  });

  it("says the same for a rig member", async () => {
    answer(503, "auth_unavailable", rigMotive);
    renderFlow();

    await newUser().click(await screen.findByRole("button", { name: /start inspection/i }));

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Sign-in is unavailable right now. Try again shortly. Your readings are saved.",
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload rig" })).toBeNull();
  });
});

const cachedAt = (
  updatedAt: number,
  units: CaptureContext[] = [{ ...context, lastOdometerAgeDays: 1 }],
) => {
  const client = testQueryClient();
  for (const u of units) {
    client.setQueryData(captureContextQuery(u.vehicleId).queryKey, u, { updatedAt });
  }
  return client;
};
const dayAgo = () => Date.now() - 86_400_000;

// A renewal the walk-around must not show (U186): another fleet number, and a
// 20mm removal threshold, which a 13mm tread is at or below.
const renewed: CaptureContext = {
  ...context,
  fleetNumber: "RENEWED",
  config: { ...context.config, removalThresholdMm: 20 },
};

// Waits for a renewal to land in the cache, so an assertion on the screen
// after it cannot pass by racing it.
const landed = (client: QueryClient, id: string, check: (c: CaptureContext) => boolean) =>
  waitFor(() => {
    const cached = client.getQueryData<CaptureContext>(captureContextQuery(id).queryKey);
    expect(cached !== undefined && check(cached)).toBe(true);
  });

const heldOnScreen = () => {
  expect(screen.queryByText("Loading…")).toBeNull();
  expect(screen.getAllByText("BAC039SP")).not.toHaveLength(0);
  expect(screen.queryAllByText(/RENEWED/)).toHaveLength(0);
};

// Answers each unit's GET at once, except the one held open until the test
// answers it, so a screen can be asserted while that renewal is in flight.
function serveOpen(open: string, answered: CaptureContext[] = []) {
  let answer: (c: CaptureContext) => void = () => undefined;
  const pending = new Promise<CaptureContext>((resolve) => (answer = resolve));
  const byId = new Map(answered.map((c) => [c.vehicleId, c]));
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const id = url.split("?")[0].split("/").pop() ?? "";
      const reply = id === open ? pending : Promise.resolve(byId.get(id));
      return reply.then((c) => ({ ok: true, status: 200, json: () => Promise.resolve(c) }));
    }),
  );
  return (c: CaptureContext) => answer(c);
}
// Types digits on the open sheet and waits for the field they move it to.
async function typeInto(user: UserEvent, digits: string[], next: string) {
  for (const d of digits) await user.click(screen.getByRole("button", { name: d }));
  await waitFor(() => expect(screen.getByLabelText(next)).toHaveAttribute("aria-current", "true"));
}
const inFlight = (client: QueryClient, id: string) =>
  waitFor(() =>
    expect(client.getQueryState(captureContextQuery(id).queryKey)?.fetchStatus).toBe("fetching"),
  );

// Rule 6: a context read at now counts its days to the tenant's day it was
// fetched on, and a draft's windowed read counts to the tenant day of its
// start, or of now if the start is later (U187). The cache never
// garbage-collects either (gcTime, captureContextQuery).
describe("a vehicle loaded on an earlier day", () => {
  const askedForV1 = (api: ReturnType<typeof stubApi>) =>
    api.mock.calls.some(([url]) => url.split("?")[0].endsWith("/vehicles/v1"));

  it("is loaded again when a capture opens on a later day", async () => {
    const api = stubApi(201, [{ ...context, lastOdometerAgeDays: 2 }]);
    renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, {
      client: cachedAt(Date.now() - 86_400_000),
    });

    expect(await screen.findByText("Last reading 412,180 km, 2 days ago")).toBeInTheDocument();
    expect(askedForV1(api)).toBe(true);
  });

  it("is read from the cache on the day it was loaded", async () => {
    const api = stubApi(201, [{ ...context, lastOdometerAgeDays: 2 }]);
    renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, {
      client: cachedAt(Date.now()),
    });

    expect(await screen.findByText("Last reading 412,180 km, 1 day ago")).toBeInTheDocument();
    expect(askedForV1(api)).toBe(false);
  });

  // FR-OFF-001: offline it is the only copy there is.
  it("is kept offline", async () => {
    stubApi(201, [{ ...context, lastOdometerAgeDays: 2 }]);
    onlineManager.setOnline(false);
    try {
      renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, {
        client: cachedAt(Date.now() - 86_400_000),
      });
      expect(await screen.findByText("Last reading 412,180 km, 1 day ago")).toBeInTheDocument();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  // U179 (TYRE-334): a renewal that fails keeps the copy, so the start
  // screen shows it rather than "Could not load". A phone with bars and no
  // data reads as online.
  it("keeps the earlier day's copy when the renewal fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, {
      client: cachedAt(Date.now() - 86_400_000),
    });

    expect(await screen.findByText("Last reading 412,180 km, 1 day ago")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  // A resumed draft keys on its own window, seeded from the copy (U148),
  // which nothing may empty while signal is weak.
  it("carries a resumed draft on the copy when the fetch fails", async () => {
    await startDraft({
      driverSubject: DRIVER,
      vehicleId: "v1",
      taskId: null,
      startedAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, {
      client: cachedAt(Date.now() - 86_400_000),
    });

    expect(await screen.findAllByRole("button", { name: /^Position 1,/ })).not.toHaveLength(0);
    expect(screen.queryByText(/Could not load/)).toBeNull();
  });

  // A start screen left open overnight renews on the next focus, which an
  // unlocked phone fires, not only when a capture opens.
  it("is loaded again on focus once the day has turned", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      stubApi(201, [{ ...context, lastOdometerAgeDays: 2 }]);
      renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, {
        client: cachedAt(Date.now()),
      });
      expect(await screen.findByText("Last reading 412,180 km, 1 day ago")).toBeInTheDocument();

      vi.setSystemTime(Date.now() + 86_400_000);
      act(() => {
        focusManager.setFocused(false);
        focusManager.setFocused(true);
      });

      expect(await screen.findByText("Last reading 412,180 km, 2 days ago")).toBeInTheDocument();
    } finally {
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  const focus = () =>
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
  const reads = (api: { mock: { calls: unknown[][] } }) =>
    api.mock.calls.filter(([url, init]) => {
      const method = (init as { method?: string } | undefined)?.method;
      return (method === undefined || method === "GET") && String(url).includes("/vehicles/v1");
    }).length;

  // U186: past Start the walk-around reads the context held at Start. While
  // the renewal is open no Loading covers the sheet, and once it lands the
  // sheet keeps its field and its threshold.
  it("keeps a fresh capture's walk-around through a focus once the day has turned", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const user = newUser();
      stubApi();
      const client = cachedAt(Date.now());
      renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, { client });
      await user.click(await screen.findByRole("button", { name: /start inspection/i }));
      await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));
      await user.click(screen.getByRole("button", { name: "1" }));
      const answer = serveOpen("v1");

      vi.setSystemTime(Date.now() + 86_400_000);
      focus();
      await inFlight(client, "v1");
      await typeInto(user, ["3"], "Tread reading 2 of 3");
      expect(screen.queryByText("Loading…")).toBeNull();

      answer(renewed);
      await landed(client, "v1", (c) => c.fleetNumber === "RENEWED");
      await typeInto(user, ["1", "3"], "Tread reading 3 of 3");
      await typeInto(user, ["1", "4"], "Pressure");

      heldOnScreen();
      expect(screen.getByLabelText("Tread reading 1 of 3")).toHaveTextContent("13");
      expect(screen.queryByText(/replacement point/)).toBeNull();
    } finally {
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  // The same after a failed start-screen renewal, whose copy stays stale, so
  // a focus past Start renews it.
  it("keeps the walk-around on the copy after a failed start-screen renewal", async () => {
    try {
      const user = newUser();
      const api = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
      vi.stubGlobal("fetch", api);
      const client = cachedAt(dayAgo());
      renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, { client });
      const start = await screen.findByRole("button", { name: /start inspection/i });
      expect(reads(api)).toBeGreaterThan(0);
      await user.click(start);
      await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));
      await user.click(screen.getByRole("button", { name: "1" }));
      const answer = serveOpen("v1");

      focus();
      await inFlight(client, "v1");
      await typeInto(user, ["3"], "Tread reading 2 of 3");
      expect(screen.queryByText("Loading…")).toBeNull();

      answer(renewed);
      await landed(client, "v1", (c) => c.fleetNumber === "RENEWED");
      await typeInto(user, ["1", "3"], "Tread reading 3 of 3");
      await typeInto(user, ["1", "4"], "Pressure");

      heldOnScreen();
      expect(screen.getByLabelText("Tread reading 1 of 3")).toHaveTextContent("13");
      expect(screen.queryByText(/replacement point/)).toBeNull();
    } finally {
      focusManager.setFocused(undefined);
    }
  });

  // A renewal with a copy in hand tries once: every retry holds the start
  // screen on Loading, up to 10s each on a phone with bars and no data.
  it("tries a renewal once when a copy is in hand", async () => {
    const api = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    vi.stubGlobal("fetch", api);
    renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, {
      client: cachedAt(Date.now() - 86_400_000),
    });

    expect(await screen.findByText("Last reading 412,180 km, 1 day ago")).toBeInTheDocument();
    expect(api).toHaveBeenCalledTimes(1);
  });

  // U182: a draft's window is held once loaded, and a read with nothing
  // loaded tries again when signal returns.
  it("loads a resumed draft's failed read when signal returns", async () => {
    await startDraft({
      driverSubject: DRIVER,
      vehicleId: "v1",
      taskId: null,
      startedAt: new Date(Date.now() - 3_600_000).toISOString(),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    renderFlow();
    expect(await screen.findByRole("button", { name: "Reload vehicle" })).toBeInTheDocument();

    stubApi();
    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });

    expect(await screen.findAllByRole("button", { name: /^Position 1,/ })).not.toHaveLength(0);
  });
});

// U186: past Start the walk-around and the review read held contexts. A
// renewal of a held unit that starts or resumes after Start reaches the cache
// only.
describe("the contexts held at Start", () => {
  const mount = (client: QueryClient) =>
    renderWithActor(<CaptureFlow vehicleId="v1" taskId={null} />, { client });

  // The screen leaves Start once the draft is written, so a renewal that
  // lands during that write must not be what the walk-around reads.
  it("holds the contexts at the tap, before the draft write leaves the start screen", async () => {
    const user = newUser();
    stubApi();
    const client = testQueryClient();
    let release: () => void = () => undefined;
    const written = new Promise<void>((resolve) => (release = resolve));
    const put = db.drafts.put.bind(db.drafts);
    vi.spyOn(db.drafts, "put").mockImplementationOnce(((...args: Parameters<typeof put>) =>
      written.then(() => put(...args))) as never);
    mount(client);
    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    stubApi(201, [renewed]);
    await act(() => client.invalidateQueries({ queryKey: ["capture-context"] }));
    await landed(client, "v1", (c) => c.fleetNumber === "RENEWED");
    release();

    await screen.findAllByRole("button", { name: /^Position 1,/ });
    heldOnScreen();
  });

  // FR-OFF-001, U186: offline, the start screen's renewal pauses, and the
  // library resumes it when signal returns, after Start.
  it("keeps the walk-around on its context when a renewal paused before Start lands", async () => {
    const user = newUser();
    stubApi(201, [renewed]);
    const client = cachedAt(dayAgo());
    onlineManager.setOnline(false);
    try {
      mount(client);
      await user.click(await screen.findByRole("button", { name: /start inspection/i }));
      await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));
      await user.click(screen.getByRole("button", { name: "1" }));
      act(() => onlineManager.setOnline(true));
      await landed(client, "v1", (c) => c.fleetNumber === "RENEWED");
      await user.click(screen.getByRole("button", { name: "3" }));

      heldOnScreen();
      expect(screen.getByLabelText("Tread reading 1 of 3")).toHaveTextContent("13");
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("keeps a rig's trailer on its context when a renewal paused before Start lands", async () => {
    const user = newUser();
    const answer = serveOpen("v2", [rigMotive]);
    const client = cachedAt(dayAgo(), [rigMotive, trailer]);
    onlineManager.setOnline(false);
    try {
      mount(client);
      await user.click(await screen.findByRole("button", { name: /start inspection/i }));
      await screen.findAllByRole("button", { name: /, BAC711TR, / });
      act(() => onlineManager.setOnline(true));
      await inFlight(client, "v2");
      expect(screen.queryByText("Loading…")).toBeNull();
      answer({ ...trailer, fleetNumber: "RENEWED-TR" });
      await landed(client, "v2", (c) => c.fleetNumber === "RENEWED-TR");

      heldOnScreen();
      expect(screen.getAllByText("BAC711TR")).not.toHaveLength(0);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  // The member list is read from the held motive, so a combination changed
  // at the office does not drop a unit from the open walk-around.
  it("keeps every unit on the walk-around when a renewal after Start drops the combination", async () => {
    const user = newUser();
    stubApi(201, [{ ...rigMotive, combination: null }, trailer]);
    const client = cachedAt(dayAgo(), [rigMotive, trailer]);
    onlineManager.setOnline(false);
    try {
      mount(client);
      await user.click(await screen.findByRole("button", { name: /start inspection/i }));
      await screen.findAllByRole("button", { name: /, BAC711TR, / });
      act(() => onlineManager.setOnline(true));
      await landed(client, "v1", (c) => c.combination === null);

      expect(screen.getByRole("heading", { name: "0 of 3 done" })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: /, BAC711TR, / })).toHaveLength(2);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  // U179: a member with a copy has not failed, so the reload asks only for
  // the one that has none.
  it("reloads only the rig member that has no copy", async () => {
    const user = newUser();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    mount(cachedAt(dayAgo(), [rigMotive]));
    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await screen.findByRole("button", { name: "Reload rig" });
    const api = stubApi(201, [{ ...rigMotive, fleetNumber: "RENEWED" }, trailer]);
    await user.click(screen.getByRole("button", { name: "Reload rig" }));

    await screen.findAllByRole("button", { name: /, BAC711TR, / });
    expect(contextReads(api)).toEqual(["/api/capture/vehicles/v2"]);
    heldOnScreen();
  });

  // A client-level call reaches the query whatever its refetch flags say, so
  // the walk-around must not read the query past Start.
  it.each([
    ["an invalidate", (c: QueryClient) => c.invalidateQueries({ queryKey: ["capture-context"] })],
    ["a refetch", (c: QueryClient) => c.refetchQueries({ queryKey: ["capture-context"] })],
  ])("keeps the walk-around on its context through %s of the key", async (_name, call) => {
    const user = newUser();
    stubApi();
    const client = testQueryClient();
    mount(client);
    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));
    await user.click(screen.getByRole("button", { name: "1" }));
    stubApi(201, [renewed]);

    await act(() => call(client));
    await landed(client, "v1", (c) => c.fleetNumber === "RENEWED");
    await user.click(screen.getByRole("button", { name: "3" }));

    heldOnScreen();
    expect(screen.getByLabelText("Tread reading 1 of 3")).toHaveTextContent("13");
  });

  // A reset empties the query, so the screen must not wait on its refetch.
  it("keeps the walk-around on its context while a reset of the key refetches", async () => {
    const user = newUser();
    const api = stubApi();
    const client = testQueryClient();
    mount(client);
    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));
    await user.click(screen.getByRole("button", { name: "1" }));
    api.mockImplementation(() => new Promise<never>((resolve) => void resolve));

    act(() => void client.resetQueries({ queryKey: ["capture-context"] }));
    await waitFor(() =>
      expect(client.getQueryState(captureContextQuery("v1").queryKey)?.status).toBe("pending"),
    );
    await user.click(screen.getByRole("button", { name: "3" }));

    heldOnScreen();
    expect(screen.getByLabelText("Tread reading 1 of 3")).toHaveTextContent("13");
  });

  // A reset whose refetch fails leaves the query with no data, which past
  // Start is not a failure to load a held unit.
  it("keeps a rig's walk-around when a reset of the key fails to refetch", async () => {
    const user = newUser();
    stubApi(201, [rigMotive, trailer]);
    const client = testQueryClient();
    mount(client);
    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await screen.findAllByRole("button", { name: /, BAC711TR, / });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await act(() => client.resetQueries({ queryKey: ["capture-context"] }));
    await waitFor(() =>
      expect(client.getQueryState(captureContextQuery("v2").queryKey)?.status).toBe("error"),
    );

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByRole("button", { name: /, BAC711TR, / })).toHaveLength(2);
    heldOnScreen();
  });

  // U186 holds to Done. A remount in the same tab resumes through the
  // draft's window, which a renewal of the at-now read after Start does not
  // reach.
  it("resumes a same-tab remount on the contexts held at Start", async () => {
    const user = newUser();
    stubApi(201, [renewed]);
    const client = cachedAt(dayAgo());
    onlineManager.setOnline(false);
    try {
      const first = mount(client);
      await user.click(await screen.findByRole("button", { name: /start inspection/i }));
      await screen.findAllByRole("button", { name: /^Position 1,/ });
      act(() => onlineManager.setOnline(true));
      await landed(client, "v1", (c) => c.fleetNumber === "RENEWED");
      first.unmount();

      mount(client);
      await screen.findAllByRole("button", { name: /^Position 1,/ });
      heldOnScreen();
    } finally {
      onlineManager.setOnline(true);
    }
  });
});

// U186: a cold reload holds no copy, so when the draft's read serves a rig
// other than the one the draft was started on, the walk-around is the list
// the draft was resumed with.
describe("a cold reload of a rig draft after the office changed the rig", () => {
  const unit = (vehicleId: string, fleetNumber: string): CaptureContext => ({
    ...trailer,
    vehicleId,
    fleetNumber,
    positions: trailer.positions.map((p) => ({ ...p, vehicleId })),
  });
  const member = (vehicleId: string, fleetNumber: string, sequence: number) => ({
    vehicleId,
    fleetNumber,
    sequence,
    descriptor: null,
  });
  const stamped = (observed: string[]) =>
    startDraft({
      driverSubject: DRIVER,
      vehicleId: "v1",
      taskId: null,
      startedAt: "2026-10-22T06:00:00.000Z",
      fleetNumber: "BAC039SP",
      combinationId: "c1",
      observedMemberVehicleIds: observed,
    });
  const unitsRead = (api: ReturnType<typeof stubApi>) =>
    contextReads(api)
      .map((u) => u.split("?")[0].split("/").pop())
      .sort();
  // Each test asserts on the screen Loading gives way to, so a wrong screen
  // fails on what it shows rather than on the test's timeout.
  const settled = () => waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

  // The office ended the rig with a date before the start, so the read
  // serves no rig.
  it("walks every unit the draft observed when the read serves no rig", async () => {
    await stamped(["v1", "v2"]);
    const api = stubApi(201, [{ ...rigMotive, combination: null }, trailer]);
    renderFlow();

    await settled();
    expect(screen.getByRole("heading", { name: /done$/ })).toHaveTextContent("0 of 3 done");
    expect(screen.getAllByRole("button", { name: /, BAC711TR, / })).toHaveLength(2);
    expect(unitsRead(api)).toEqual(["v1", "v2"]);
  });

  // The rig was replaced before Start while the phone's copy still showed
  // the old one, so the read serves a rig that lacks v2 and adds v3.
  it("walks the draft's units in the draft's order when the read serves another rig", async () => {
    await stamped(["v1", "v2", "v4"]);
    const api = stubApi(201, [
      {
        ...rigMotive,
        combination: {
          id: "c2",
          members: [
            member("v1", "BAC039SP", 1),
            member("v4", "BAC744TR", 2),
            member("v3", "BAC733TR", 3),
          ],
        },
      },
      trailer,
      unit("v3", "BAC733TR"),
      unit("v4", "BAC744TR"),
    ]);
    renderFlow();

    await settled();
    expect(screen.getByRole("heading", { name: /done$/ })).toHaveTextContent("0 of 5 done");
    expect(screen.getByRole("button", { name: /^Position 1, BAC039SP,/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Position 3, BAC711TR,/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Position 5, BAC744TR,/ })).toBeInTheDocument();
    expect(unitsRead(api)).toEqual(["v1", "v2", "v4"]);
  });

  // FR-AUT-005: a driver who held v2 only through a rig that ended before
  // the start is refused it over the draft's window.
  it("says a unit of the draft the read refuses is refused", async () => {
    await stamped(["v1", "v2"]);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url.split("?")[0].endsWith("/v1")
            ? json(200, { ...rigMotive, combination: null })
            : json(403, { code: "forbidden", message: "x" }),
        ),
      ),
    );
    renderFlow();

    await settled();
    expect(screen.getByRole("alert").textContent).toBe(
      "You do not have permission to inspect a unit on this rig. Ask your fleet office to check you are assigned to it. Your readings are saved.",
    );
  });
});

describe("a held 401 inside capture", () => {
  // Passing null for lastStatus would leave the signal wording here.
  it("tells the driver to sign in to send it when the submit is refused with 401", async () => {
    const user = newUser();
    stubApi(401, [context], "unauthorized");
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    expect(await screen.findByRole("heading", { name: "Inspection saved" })).toBeInTheDocument();
    expect(screen.getByText("Sign in to send it.")).toBeInTheDocument();
    expect(await db.table("outbox").count()).toBe(1);
  });
});

describe("what the done screen says a queued submit waits on", () => {
  // U104: a sign-in in another tab can leave another driver's credential
  // here, and sendEntry then refuses the stamp without recording anything.
  it("names the capturing driver's sign-in when the credential is another driver's", async () => {
    const user = newUser();
    const api = stubApi(201);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    setDevActorId("oid-driver-2");
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    expect(await screen.findByRole("heading", { name: "Inspection saved" })).toBeInTheDocument();
    expect(
      screen.getByText("The driver who captured it needs to sign in here to send it."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/while the app is open with signal/)).toBeNull();
    expect(api.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(await db.table("outbox").count()).toBe(1);
  });

  it("keeps the signal line for this driver's submit with no signal", async () => {
    const user = newUser();
    stubApi(201);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    expect(await screen.findByRole("heading", { name: "Inspection saved" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "It sends by itself while the app is open with signal. You can close the app.",
      ),
    ).toBeInTheDocument();
    expect(await db.table("outbox").count()).toBe(1);
  });
});
