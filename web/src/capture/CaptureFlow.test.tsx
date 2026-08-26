import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { expectNothingForbiddenSpoken } from "../test/spoken";
import { CaptureFlow } from "./CaptureFlow";
import type { CaptureContext } from "./captureContext";
import { clearDraft, db } from "./draft";
import { listOutbox } from "./outbox";

// CaptureFlow uses useCaptureContext -> useQuery, so an unwrapped render
// throws before any assertion runs. retry:false matters too: the default
// three retries would make the "refuses to start" test wait them out.
function renderFlow() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CaptureFlow vehicleId="v1" taskId={null} />
    </QueryClientProvider>,
  );
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
  combination: null,
  positions: [
    {
      id: "p1",
      vehicleId: "v1",
      code: "1",
      sequence: 1,
      axleClass: "STEER",
      axleType: "FIXED",
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
  // one rig share every id — the register cannot produce the distinct-id shape,
  // and a fixture that used one would let a collision between units pass
  // unseen while looking like better coverage.
  positions: [
    { ...context.positions[0], vehicleId: "v2", code: "1", sequence: 1 },
    { ...context.positions[0], id: "p2", vehicleId: "v2", code: "2", sequence: 2 },
  ],
};

// GET the context of whichever unit was asked for, POST the inspection. Routed
// on method and on the vehicle in the path, so neither the order the component
// calls in nor which unit it asks for first decides whether the test passes.
function stubApi(submitStatus = 201, served: CaptureContext[] = [context]) {
  const byId = new Map(served.map((c) => [c.vehicleId, c]));
  const api = vi.fn((url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      return Promise.resolve({
        ok: submitStatus < 400,
        status: submitStatus,
        json: () => Promise.resolve({ inspectionId: "i1" }),
      });
    }
    const asked = byId.get(url.split("/").pop() ?? "");
    return Promise.resolve(
      asked
        ? { ok: true, status: 200, json: () => Promise.resolve(asked) }
        : { ok: false, status: 404, json: () => Promise.resolve({}) },
    );
  });
  vi.stubGlobal("fetch", api);
  return api;
}

// Real timers, throughout. CaptureFlow writes to IndexedDB on every keystroke
// (FR-OFF-005), and Dexie completes its requests on a real setTimeout — faking
// setTimeout deadlocks every write, and faking anything less cannot drive the
// 200ms settle this helper depends on. So each step waits for the state the
// settle produces (the next field taking aria-current) instead of for a fixed
// number of ticks. See docs/lessons.md, "Fake timers deadlock IndexedDB".
//
// Digits are entered a field at a time and the settle is waited out between
// them: clicking nine digits straight through lands them all in field 1, where
// everything past the second overshoots 35mm and restarts the buffer — a green
// test over corrupt data.
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
  // A position with nothing to flag finishes itself off the pressure field; a
  // warned one waits for the tap that records the FR-INS-040 response. Either
  // way the sheet that was open must go — on to the next outstanding position,
  // or back to the diagram when none are left.
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
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // The storage-failure tests spy on Dexie's own methods; a leaked spy would
  // fail the next block somewhere with no connection to its cause.
  vi.restoreAllMocks();
  await clearDraft();
  await db.table("outbox").clear();
});

const newUser = () => userEvent.setup();

describe("CaptureFlow", () => {
  // NFR-AVL-002: "Starting a new inspection requires the server." Capture and
  // submit do not — but a driver must not be able to start against reference
  // data that never arrived, because every threshold would then be missing
  // and every warning would silently never fire.
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
    stubApi(409);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    await user.click(screen.getByRole("button", { name: /review and submit/i }));
    await user.click(screen.getByRole("button", { name: /submit inspection/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/already inspected/i);
    expect(await db.table("outbox").count()).toBe(1);
  });

  // NFR-USE-011 / FR-OFF-006: the buffer is the source of truth, so a remount
  // is a reload and finds the work — with its numbers, not just its progress.
  it("resumes an in-progress inspection after a remount", async () => {
    const user = newUser();
    stubApi();
    const { unmount } = renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await capturePosition(user);
    unmount();

    renderFlow();
    await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));
    expect(screen.getByLabelText(/Tread reading 1 of 3/)).toHaveTextContent("13");
  });

  // The diagram's active mark is the driver's place-keeper across a 27-position
  // walk-around. Marking every cell satisfies "the open one is marked" just as
  // well as marking one, so the assertion is on the whole set, not on the cell
  // that was opened.
  it("marks the open position on the diagram and no other", async () => {
    const user = newUser();
    stubApi(201, [twoPositions]);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));

    const cells = Array.from(document.querySelectorAll<HTMLElement>(".cap-pos"));
    expect(cells).toHaveLength(2);
    expect(
      cells.filter((c) => c.classList.contains("is-active")).map((c) => c.dataset.positionId),
    ).toEqual(["p1"]);
  });

  // app.inspection.completeness_pct defaults to 100, so a partial inspection
  // submitted without it is recorded as complete (NFR-PRO-003). The denominator
  // is every position on every confirmed unit (FR-INS-065) — a rig, not the
  // motive unit, which is what makes 1-of-3 distinguishable from 1-of-1 here.
  // The count the driver reads at review and the figure the server stores come
  // off the same expression, so this asserts both.
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

  // NFR-USE-001a. Finishing a position opens the next outstanding one, so the
  // driver pays one tap to open the first wheel of the walk and none after
  // that; returning them to the diagram to hunt for the next cell costs a tap
  // and a re-orientation on each of a superlink's 27.
  //
  // The rig fixture is the sharp case: both units carry position ids p1 and
  // p2, because app.position belongs to an axle configuration and not to a
  // vehicle. A "next outstanding" that asked by id would find p1 done and step
  // over the trailer's first wheel (BR-VEH-003, draft.cellKey).
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

  // Swept at every stage of the journey, not once at the end: by the time the
  // review screen renders, start and capture have unmounted and the done
  // screen has not been reached, so a single sweep guards one screen out of
  // four and reads like it guards all of them.
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

  // FR-OFF-014 / NFR-USE-005. IndexedDB throws outright under a private window
  // or an MDM policy blocking site data. The driver then taps a Start button
  // that can never work, so the screen they are standing on has to say why —
  // which requires the alert to sit above the screen switch, not inside one
  // branch of it.
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
    expect(screen.getByRole("button", { name: /start inspection/i })).toBeDisabled();
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

  // The half that proves the retry re-attempts rather than just clearing the
  // message: a retry that only hid the banner would leave a driver on a screen
  // with an enabled Start button and no warning, which is where this round
  // started.
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

  // The storage alert is hoisted above the screen switch (CaptureFlow's
  // return, below) while the context-fetch failure renders inside it, so a
  // locked-down phone with no signal shows both retries at once. Two
  // controls that read the same leave a driver guessing which tap does
  // what, so this asserts the names differ, not just that two buttons exist.
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

  // The defect this reconciles: a position whose treads are read and whose
  // pressure was never taken is captured, is counted, and is sent (000023
  // accepts a NULL pressure). Banding the cell on the pressure as well drew it
  // "Not done" — hiding FR-INS-036 on a cell the app had every number for, and
  // sending the driver back across the yard for a wheel already done while the
  // header above said it was.
  it("bands a tread-complete position with no pressure, and counts it done", async () => {
    const user = newUser();
    stubApi(201);
    renderFlow();

    await user.click(await screen.findByRole("button", { name: /start inspection/i }));
    await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));

    // 3mm does not settle the field — another digit still fits under 35mm — so
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
      await screen.findByRole("button", { name: "Position 1, BAC039SP, Report" }),
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
});
