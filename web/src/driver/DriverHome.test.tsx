import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import { renderWithActor, requestedUrl, respond, testQueryClient } from "../test/fixtures";
import { expectNothingForbiddenSpoken } from "../test/spoken";
import { clearDevActorId, setDevActorId } from "../api/devTenant";
import { formatTenantDate, formatTenantInstant } from "../time/tenantTime";
import * as outbox from "../capture/outbox";
import { clearDraft, db, startDraft } from "../capture/draft";
import { DriverHome } from "./DriverHome";
import { INSTALL_HINT_KEY, startInstallOffer } from "./installOffer";
import { myTasksQuery, myTripQuery } from "./driver.data";

const DUE = "2026-10-23T06:00:00Z";
const DUE_TEXT = formatTenantDate(DUE, "Africa/Johannesburg");

interface Task {
  id: string;
  vehicleId: string;
  fleetNumber: string;
  dueAt: string;
  state: string;
  overdue: boolean;
  captureVehicleId?: string;
}

function task(overrides: Partial<Task> & Pick<Task, "id" | "vehicleId" | "fleetNumber">): Task {
  return { dueAt: DUE, state: "OPEN", overdue: false, ...overrides };
}

const H1 = { vehicleId: "h1", fleetNumber: "H1" };
const T1 = { vehicleId: "t1", fleetNumber: "T1" };
const T2 = { vehicleId: "t2", fleetNumber: "T2" };

function onTrip(trailers = [T1, T2]) {
  return {
    trip: {
      id: "trip1",
      motive: H1,
      driver: { userId: "u0", displayName: "Test" },
      startedAt: "2026-10-22T05:00:00Z",
      startedBy: null,
      endedAt: null,
      trailers,
    },
  };
}

type Answer = { status: number; body: unknown } | "pending";

// Routed by URL, so neither query's order decides the answer.
function stub(tasks: Answer, trip: Answer) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = requestedUrl(input);
      const answer = url === "/api/my/tasks" ? tasks : url === "/api/my/trip" ? trip : null;
      if (answer === null) throw new Error(`unstubbed ${url}`);
      if (answer === "pending") return new Promise<Response>(() => undefined);
      return Promise.resolve(respond(answer.status, answer.body));
    }),
  );
}

const ok = (body: unknown): Answer => ({ status: 200, body });

function renderHome() {
  return renderWithActor(<DriverHome />, { withRouter: true });
}

function hrefOf(name: string | RegExp): string | null {
  return screen.getByRole("link", { name }).getAttribute("href");
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the driver's home", () => {
  // The trip's units in rig order, each with its due links; a
  // unit with nothing due is named, not linked.
  it("lists the truck then each trailer of the trip, with their due inspections", async () => {
    stub(
      ok([
        task({ id: "k2", vehicleId: "t2", fleetNumber: "T2", overdue: true }),
        task({ id: "k1", vehicleId: "h1", fleetNumber: "H1", captureVehicleId: "h1" }),
      ]),
      ok(onTrip()),
    );
    const { container } = renderHome();

    const section = await screen.findByRole("region", { name: "Your trip" });
    const items = within(section).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      `H1, due ${DUE_TEXT}`,
      "T1",
      `T2, due ${DUE_TEXT} (overdue)`,
    ]);
    expect(within(items[0]).getByRole("link").getAttribute("href")).toBe("/capture/h1?taskId=k1");
    expect(within(items[1]).queryByRole("link")).toBeNull();
    expect(screen.queryByText("Nothing due.")).toBeNull();
    // CR-010/OR-LEG-001 (TYRE-207): the driver's home is a driver screen.
    expectNothingForbiddenSpoken(container, /overdue/);
  });

  it("says nothing is due once for a trip with nothing due", async () => {
    stub(ok([]), ok(onTrip()));
    renderHome();

    await screen.findByRole("region", { name: "Your trip" });
    expect(screen.getAllByText("Nothing due.")).toHaveLength(1);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("lists a nominee's units under their own heading", async () => {
    stub(
      ok([task({ id: "k9", vehicleId: "x9", fleetNumber: "X9", captureVehicleId: "x9" })]),
      ok({ trip: null }),
    );
    const { container } = renderHome();

    const section = await screen.findByRole("region", { name: "Nominated inspections" });
    expect(within(section).getByRole("link").getAttribute("href")).toBe("/capture/x9?taskId=k9");
    expect(screen.queryByRole("region", { name: "Your trip" })).toBeNull();
    expect(screen.queryByText("You are not on a trip.")).toBeNull();
    expectNothingForbiddenSpoken(container, /nominated inspections/);
  });

  // A solo trailer capture would lose the rig, so a coupled
  // trailer's task opens its motive's capture, naming the trailer's task.
  it("links each task to the unit it is captured through", async () => {
    stub(
      ok([
        task({ id: "kt1", vehicleId: "t1", fleetNumber: "T1", captureVehicleId: "h1" }),
        task({ id: "kn", vehicleId: "n1", fleetNumber: "N1", captureVehicleId: "m1" }),
        task({ id: "ks", vehicleId: "s1", fleetNumber: "S1", captureVehicleId: "s1" }),
        task({ id: "ko", vehicleId: "o1", fleetNumber: "O1" }),
      ]),
      ok(onTrip([T1])),
    );
    renderHome();

    await screen.findByRole("region", { name: "Nominated inspections" });
    expect(hrefOf(/^T1,/)).toBe("/capture/h1?taskId=kt1");
    expect(hrefOf(/^N1,/)).toBe("/capture/m1?taskId=kn");
    expect(hrefOf(/^S1,/)).toBe("/capture/s1?taskId=ks");
    // An API older than the web sends no captureVehicleId.
    expect(hrefOf(/^O1,/)).toBe("/capture/o1?taskId=ko");
  });

  it("shows both sections at once and each task once", async () => {
    stub(
      ok([
        task({ id: "k1", vehicleId: "h1", fleetNumber: "H1", captureVehicleId: "h1" }),
        task({ id: "k9", vehicleId: "x9", fleetNumber: "X9", captureVehicleId: "x9" }),
      ]),
      ok(onTrip([])),
    );
    renderHome();

    const trip = await screen.findByRole("region", { name: "Your trip" });
    const nominated = screen.getByRole("region", { name: "Nominated inspections" });
    expect(
      within(trip)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/capture/h1?taskId=k1"]);
    expect(
      within(nominated)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual(["/capture/x9?taskId=k9"]);
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("says the driver is not on a trip when there is no trip and no task", async () => {
    stub(ok([]), ok({ trip: null }));
    const { container } = renderHome();

    expect(await screen.findByText("You are not on a trip.")).toBeInTheDocument();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expectNothingForbiddenSpoken(container, /not on a trip/);
  });

  // The one tap to a task is never held behind the second read.
  it("links the tasks as soon as they load, while the trip is still loading", async () => {
    stub(ok([task({ id: "k1", vehicleId: "h1", fleetNumber: "H1" })]), "pending");
    renderHome();

    expect(await screen.findByRole("link", { name: /^H1,/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "My inspections" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Your trip" })).toBeNull();
  });

  it("keeps the task links when the trip cannot load, and says so", async () => {
    stub(ok([task({ id: "k1", vehicleId: "h1", fleetNumber: "H1" })]), {
      status: 500,
      body: {},
    });
    const { container } = renderHome();

    expect(await screen.findByRole("alert")).toHaveTextContent(/trip/i);
    expect(hrefOf(/^H1,/)).toBe("/capture/h1?taskId=k1");
    expect(screen.getByRole("heading", { name: "My inspections" })).toBeInTheDocument();
    expectNothingForbiddenSpoken(container, /could not load your trip/);
  });

  it("shows the trip when the tasks cannot load, and says so", async () => {
    stub({ status: 500, body: {} }, ok(onTrip()));
    const { container } = renderHome();

    expect(await screen.findByRole("alert")).toHaveTextContent(/inspections/i);
    const section = await screen.findByRole("region", { name: "Your trip" });
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["H1", "T1", "T2"]);
    // Nothing is known to be due, so nothing says so.
    expect(screen.queryByText("Nothing due.")).toBeNull();
    expect(screen.getByRole("heading", { name: "My inspections" })).toBeInTheDocument();
    expectNothingForbiddenSpoken(container, /could not load your inspections/);
  });

  it("names the heading while both reads are pending", async () => {
    stub("pending", "pending");
    renderHome();

    expect(screen.getByRole("heading", { name: "My inspections" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Loading…")).toBeInTheDocument());
  });
});

// TYRE-334: a list in hand outlives a failed refresh, which says it may be stale.
describe("a refresh that fails with the list in hand", () => {
  it("keeps the task links and says the list may be out of date", async () => {
    const client = testQueryClient();
    client.setQueryData(myTasksQuery().queryKey, [
      task({ id: "k1", vehicleId: "h1", fleetNumber: "H1" }),
    ]);
    client.setQueryData(myTripQuery().queryKey, onTrip([T1]));
    stub({ status: 500, body: {} }, ok(onTrip([T1])));
    renderWithActor(<DriverHome />, { withRouter: true, client });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Could not refresh your inspections. This list may be out of date.",
    );
    expect(hrefOf(/^H1,/)).toBe("/capture/h1?taskId=k1");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the trip and says it may be out of date", async () => {
    const client = testQueryClient();
    client.setQueryData(myTasksQuery().queryKey, []);
    client.setQueryData(myTripQuery().queryKey, onTrip([T1]));
    stub(ok([]), { status: 500, body: {} });
    renderWithActor(<DriverHome />, { withRouter: true, client });

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Could not refresh your trip. It may be out of date.",
    );
    const section = screen.getByRole("region", { name: "Your trip" });
    expect(
      within(section)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["H1", "T1"]);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// TYRE-154, spec section 4 (U243): the hint is the screen's last block, and it
// never shows while the phone holds an inspection.
describe("the install hint (TYRE-154)", () => {
  let stopOffer: () => void;
  let read: MockInstance<typeof outbox.readHeldWork>;
  const STEPS = "Add this app to your Home Screen";
  const BUTTON = "Install this app";

  beforeEach(async () => {
    await db.open();
    await clearDraft();
    await db.table("outbox").clear();
    window.localStorage.clear();
    stopOffer = startInstallOffer(window);
    read = vi.spyOn(outbox, "readHeldWork");
  });

  afterEach(() => {
    stopOffer();
    Reflect.deleteProperty(window.navigator, "standalone");
    Reflect.deleteProperty(window.navigator, "maxTouchPoints");
    vi.restoreAllMocks();
  });

  function asIPhone() {
    Object.defineProperty(window.navigator, "standalone", { value: false, configurable: true });
    Object.defineProperty(window.navigator, "maxTouchPoints", { value: 5, configurable: true });
  }

  function offerInstall() {
    const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
      prompt: vi.fn(() => Promise.resolve()),
    });
    act(() => {
      window.dispatchEvent(event);
    });
    return event.prompt;
  }

  const steps = () => screen.findByRole("status", { name: STEPS });
  const button = () => screen.findByRole("status", { name: BUTTON });
  const noHint = () => {
    expect(screen.queryByRole("status", { name: STEPS })).toBeNull();
    expect(screen.queryByRole("status", { name: BUTTON })).toBeNull();
  };

  // The lists have answered, so InstallHint has mounted.
  async function settle() {
    await screen.findByRole("link", { name: /^H1,/ });
    await act(() => Promise.resolve());
  }

  async function readAnswered() {
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalled();
    });
    await (read.mock.results[0].value as Promise<unknown>).catch(() => undefined);
    await act(() => Promise.resolve());
  }

  // Throws for the hint's key alone; the actor's and the token store's reads
  // in the same tree are untouched.
  function hintKey(method: "getItem" | "setItem") {
    const real: unknown = Reflect.get(Storage.prototype, method);
    vi.spyOn(Storage.prototype, method).mockImplementation(function (
      this: Storage,
      ...args: string[]
    ) {
      if (args[0] === INSTALL_HINT_KEY) throw new Error("blocked");
      return Reflect.apply(real as () => unknown, this, args) as never;
    });
  }

  const lists = () => stub(ok([task({ id: "k1", ...H1 })]), ok({ trip: null }));
  const heading = () => screen.getByRole("heading", { name: "My inspections" });

  it("shows the steps on an iPhone, as the screen's last block", async () => {
    lists();
    asIPhone();
    const { container } = renderHome();

    const region = await steps();
    expect(region.textContent).toContain(
      "Tap Share, then Add to Home Screen. If you cannot see Share, tap the menu button (...) first.",
    );
    expect(region.textContent).toContain(
      "You will sign in once more when you open it from the Home Screen.",
    );
    expect(container.querySelector("section")?.lastElementChild).toBe(region);
    expectNothingForbiddenSpoken(container, /add this app to your home screen/);
  });

  it("leaves the tasks and the trip where they were", async () => {
    stub(
      ok([
        task({ id: "k2", vehicleId: "t2", fleetNumber: "T2", overdue: true }),
        task({ id: "k1", vehicleId: "h1", fleetNumber: "H1", captureVehicleId: "h1" }),
      ]),
      ok(onTrip()),
    );
    asIPhone();
    renderHome();

    const trip = await screen.findByRole("region", { name: "Your trip" });
    expect(
      within(trip)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual([`H1, due ${DUE_TEXT}`, "T1", `T2, due ${DUE_TEXT} (overdue)`]);
    expect(hrefOf(/^H1,/)).toBe("/capture/h1?taskId=k1");
    const region = await steps();
    expect(trip.compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('"Got it" removes it, writes the key, and puts focus on the heading', async () => {
    lists();
    asIPhone();
    renderHome();
    await steps();

    await userEvent.setup().click(screen.getByRole("button", { name: "Got it" }));

    noHint();
    expect(window.localStorage.getItem(INSTALL_HINT_KEY)).toBe("dismissed");
    expect(document.activeElement).toBe(heading());
  });

  it("shows none on a later render once dismissed", async () => {
    window.localStorage.setItem(INSTALL_HINT_KEY, "dismissed");
    lists();
    asIPhone();
    renderHome();
    await settle();

    expect(read).not.toHaveBeenCalled();
    noHint();
  });

  it("keeps a dismissal through a remount when the store cannot be written", async () => {
    hintKey("setItem");
    lists();
    asIPhone();
    const first = renderHome();
    await steps();
    await userEvent.setup().click(screen.getByRole("button", { name: "Got it" }));
    first.unmount();
    read.mockClear();

    renderHome();
    await settle();

    expect(read).not.toHaveBeenCalled();
    noHint();
  });

  it("stays hidden while a draft is held, whoever captured it", async () => {
    await startDraft({
      driverSubject: "oid-someone-else",
      vehicleId: "v9",
      taskId: null,
      startedAt: "2026-11-19T06:00:00Z",
    });
    lists();
    asIPhone();
    renderHome();
    await settle();
    await readAnswered();

    noHint();
  });

  it("stays hidden while an outbox entry is held, refused included", async () => {
    await db.table("outbox").put({ clientUuid: "held-1", state: "failed" });
    lists();
    asIPhone();
    renderHome();
    await settle();
    await readAnswered();

    noHint();
  });

  it("stays hidden while the held read is out", async () => {
    read.mockReturnValue(new Promise(() => undefined));
    lists();
    asIPhone();
    renderHome();
    await settle();
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalled();
    });
    await act(() => Promise.resolve());

    noHint();
  });

  it("stays hidden when the held read fails", async () => {
    vi.spyOn(db.drafts, "get").mockRejectedValue(new Error("storage blocked"));
    lists();
    asIPhone();
    renderHome();
    await settle();
    await readAnswered();

    noHint();
  });

  it("waits for the lists before it shows", async () => {
    stub("pending", "pending");
    asIPhone();
    renderHome();
    await screen.findByText("Loading…");
    await act(() => Promise.resolve());

    expect(read).not.toHaveBeenCalled();
    noHint();
  });

  it('shows the button for Chrome\'s event, and "No thanks" ends it for good', async () => {
    lists();
    offerInstall();
    const { container } = renderHome();

    const region = await button();
    expect(region.textContent).toContain("It opens from your Home screen like any other app.");
    expectNothingForbiddenSpoken(container, /install this app/);

    await userEvent.setup().click(screen.getByRole("button", { name: "No thanks" }));

    noHint();
    expect(window.localStorage.getItem(INSTALL_HINT_KEY)).toBe("dismissed");
    expect(document.activeElement).toBe(heading());
  });

  it('"Install" opens Chrome\'s dialog once and the hint goes without writing the key', async () => {
    lists();
    const prompt = offerInstall();
    renderHome();
    await button();

    await userEvent.setup().click(screen.getByRole("button", { name: "Install" }));

    expect(prompt).toHaveBeenCalledTimes(1);
    noHint();
    expect(window.localStorage.getItem(INSTALL_HINT_KEY)).toBeNull();
    expect(document.activeElement).toBe(heading());
  });

  it("shows the button when Chrome's event arrives after the screen mounted", async () => {
    lists();
    renderHome();
    await settle();

    offerInstall();

    await button();
  });

  it("shows nothing on Android with no event", async () => {
    lists();
    renderHome();
    await settle();

    expect(read).not.toHaveBeenCalled();
    noHint();
  });

  it("shows the steps under StrictMode, as main.tsx renders", async () => {
    lists();
    asIPhone();
    renderWithActor(
      <StrictMode>
        <DriverHome />
      </StrictMode>,
      { withRouter: true },
    );

    await steps();
  });

  it("shows the steps when the store cannot be read", async () => {
    hintKey("getItem");
    lists();
    asIPhone();
    renderHome();

    await steps();
  });
});

// TYRE-319 (the owner's answer 1): an inspection held on the phone is one tap
// from "My inspections", whether or not its task is still listed.
describe("the carry-on row (TYRE-319)", () => {
  const DRIVER = "oid-driver-1";
  const AT = "2026-11-20T06:00:00.000Z";
  const AT_TEXT = formatTenantInstant(AT, "Africa/Johannesburg");
  const heldH1 = {
    vehicleId: "h1",
    taskId: "k1",
    fleetNumber: "H1",
    startedAt: AT,
    driverSubject: DRIVER,
    legacy: false,
  };

  beforeEach(async () => {
    await db.open();
    await clearDraft();
    await db.table("outbox").clear();
    setDevActorId(DRIVER);
  });

  afterEach(async () => {
    clearDevActorId();
    vi.restoreAllMocks();
    await clearDraft();
  });

  const hold = (
    over: { driverSubject?: string; taskId?: string | null; fleetNumber?: string | null } = {},
  ) =>
    startDraft({
      driverSubject: DRIVER,
      vehicleId: "h1",
      taskId: "k1",
      startedAt: AT,
      fleetNumber: "H1",
      ...over,
    });
  const lists = () => stub(ok([task({ id: "k2", ...H1 })]), ok(onTrip()));
  const taskRow = () => screen.findByRole("link", { name: `H1, due ${DUE_TEXT}` });

  it("shows the driver's own held draft above every task, to its task's address", async () => {
    await hold();
    lists();
    renderHome();

    const row = await screen.findByRole("link", { name: `Carry on with H1, started ${AT_TEXT}` });
    expect(row).toHaveAttribute("href", "/capture/h1?taskId=k1");
    const first = await taskRow();
    expect(row.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("links a draft with no task to the unit alone", async () => {
    await hold({ taskId: null });
    lists();
    renderHome();

    expect(
      await screen.findByRole("link", { name: `Carry on with H1, started ${AT_TEXT}` }),
    ).toHaveAttribute("href", "/capture/h1");
  });

  it("names a draft with no fleet number as your inspection", async () => {
    await hold({ fleetNumber: null });
    lists();
    renderHome();

    expect(
      await screen.findByRole("link", {
        name: `Carry on with your inspection, started ${AT_TEXT}`,
      }),
    ).toBeInTheDocument();
  });

  it("shows no row for another driver's draft", async () => {
    await hold({ driverSubject: "oid-other" });
    lists();
    renderHome();

    await taskRow();
    expect(screen.queryByRole("link", { name: /^Carry on/ })).toBeNull();
  });

  it("a rejected draft read shows the task rows without the carry-on row (Lead's call 14)", async () => {
    vi.spyOn(outbox, "readHeldDraft").mockRejectedValue(new Error("idb"));
    lists();
    renderHome();

    await taskRow();
    expect(screen.queryByRole("link", { name: /^Carry on/ })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Loading…")).toBeNull();
  });

  it("paints no task row before the draft read has settled", async () => {
    let settle: (d: typeof heldH1) => void = () => undefined;
    vi.spyOn(outbox, "readHeldDraft").mockReturnValue(new Promise((resolve) => (settle = resolve)));
    lists();
    const client = testQueryClient();
    renderWithActor(<DriverHome />, { withRouter: true, client });

    await waitFor(() =>
      expect(client.getQueryState(myTasksQuery().queryKey)?.status).toBe("success"),
    );
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^H1,/ })).toBeNull();

    act(() => settle(heldH1));
    expect(
      await screen.findByRole("link", { name: `Carry on with H1, started ${AT_TEXT}` }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: `H1, due ${DUE_TEXT}` })).toBeInTheDocument();
  });
});
