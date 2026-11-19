import { lazy, Suspense, type ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { onlineManager, QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearDevActorId, setDevActorId } from "../api/devTenant";
import { ActorContext } from "../auth/actorContext";
import { CaptureFlow } from "../capture/CaptureFlow";
import { captureContextQuery, type CaptureContext } from "../capture/captureContext";
import { DriverHome } from "../driver/DriverHome";
import { myTasksQuery, myTripQuery } from "../driver/driver.data";
import { clearDraft, db, startDraft } from "../capture/draft";
import type { OutboxEntry } from "../capture/outbox";
import type { SubmitPayload } from "../capture/payload";
import { storageRefused, writeFailed } from "../capture/storageFaults";
import { captureContext, me, requestedUrl, respond, testQueryClient } from "../test/fixtures";
import { deriveBrandTheme } from "../theme/derive";
import { ThemeContext } from "../theme/themeContext";
import { Chrome } from "./Chrome";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

const branding = { displayName: "Sandbox Fleet", primaryColor: "#1F7A5A", logoUrl: null };
const outbox = () => db.table<OutboxEntry, string>("outbox");

const DRIVER = "oid-driver-1";
const MAY_BE_MISSING =
  "This phone was not saving reliably, so the last readings you entered may be missing. Check each position after you try again.";
const DEGRADED =
  "This phone is not saving reliably. Keep the app open until this inspection has been sent.";

// nextAttemptAt in the future: the indicator flushes on mount, and a due
// entry would be sent and never counted (OutboxIndicator.test.tsx).
function queued(clientUuid: string): OutboxEntry {
  return {
    clientUuid,
    state: "queued",
    payload: { client_uuid: clientUuid, readings: [] } as unknown as SubmitPayload,
    queuedAt: Date.now(),
    attempts: 0,
    nextAttemptAt: Date.now() + 3_600_000,
    lastStatus: null,
    lastCode: null,
    lastError: null,
    fleetNumber: null,
    driverSubject: "oid-driver-1",
    legacy: false,
  };
}

function Boom(): ReactNode {
  throw new Error("render failed");
}

// Throws until the test clears the flag, so the test, not how many times
// React renders it, decides when the page recovers.
let pageBroken = true;
function FlakyPage(): ReactNode {
  if (pageBroken) throw new Error("render failed");
  return <p>Page resumed</p>;
}

// The shell as App.tsx composes it, with test routes in place of AppRoutes.
// The nav and the outbox indicator both render nothing by default, so the
// actor holds capabilities and a queued entry is seeded: otherwise "stays
// mounted" would pass over two empty slots.
function renderAt(
  path: string | string[],
  routes: ReactNode,
  options: { client?: QueryClient; outside?: ReactNode } = {},
) {
  const reload = vi.fn();
  const onCaughtError = vi.fn();
  render(
    <QueryClientProvider client={options.client ?? testQueryClient()}>
      <ThemeContext value={{ branding, theme: deriveBrandTheme(branding.primaryColor) }}>
        <ActorContext
          value={{
            actor: me({ displayName: "Controller", capabilities: ["ViewFleet", "ManageAssets"] }),
            settled: true,
          }}
        >
          <MemoryRouter initialEntries={typeof path === "string" ? [path] : path}>
            <Chrome>
              <RouteErrorBoundary reload={reload}>
                <Suspense fallback={<p>Loading.</p>}>
                  <Routes>{routes}</Routes>
                </Suspense>
              </RouteErrorBoundary>
            </Chrome>
            {options.outside}
          </MemoryRouter>
        </ActorContext>
      </ThemeContext>
    </QueryClientProvider>,
    { onCaughtError },
  );
  return { reload, onCaughtError };
}

beforeEach(async () => {
  pageBroken = true;
  setDevActorId(DRIVER);
  await db.open();
  await clearDraft();
  await outbox().clear();
  await outbox().put(queued("u-1"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearDevActorId();
  await clearDraft();
  await outbox().clear();
});

const capturePage = () => (
  <Route path="/capture/:vehicleId" element={<CaptureFlow vehicleId="v1" taskId={null} />} />
);

// GET by path, the query string aside, so v1's read at now and over a
// draft's window get one answer; a path not listed reads as no signal.
function serveReads(byPath: Record<string, unknown>) {
  const api = vi.fn((input: RequestInfo | URL) => {
    const path = requestedUrl(input).split("?")[0];
    return Object.hasOwn(byPath, path)
      ? Promise.resolve(respond(200, byPath[path]))
      : Promise.reject(new TypeError("Failed to fetch"));
  });
  vi.stubGlobal("fetch", api);
  return api;
}

// A real draft, then a patch written under it: the shapes in the tests below
// are ones storage can hold and a real component throws on (spec, Tests).
async function seedDraft(
  options: { driverSubject?: string; startedAt?: string; patch?: Record<string, unknown> } = {},
) {
  await startDraft({
    driverSubject: options.driverSubject ?? DRIVER,
    vehicleId: "v1",
    taskId: null,
    startedAt: options.startedAt ?? new Date().toISOString(),
    fleetNumber: "BAC039SP",
  });
  const patch = options.patch;
  if (patch) await db.drafts.toCollection().modify((row) => void Object.assign(row.draft, patch));
}

// Found by its lead: the capture page's banners are alerts too.
async function errorScreen(): Promise<HTMLElement> {
  const lead = await screen.findByText(/^This page (could not|still cannot) be shown.$/);
  const shown = lead.closest<HTMLElement>('[role="alert"]');
  if (shown === null) throw new Error("the lead is not inside the error screen");
  return shown;
}
async function tryAgain(user: UserEvent) {
  await user.click(within(await errorScreen()).getByRole("button", { name: "Try again" }));
}

async function expectShellMounted() {
  expect(screen.getByRole("link", { name: "Units" })).toBeInTheDocument();
  expect(await screen.findByText("1 inspection waiting to send")).toBeInTheDocument();
}

describe("RouteErrorBoundary (U54)", () => {
  it("shows the message in the shell when a page throws while rendering", async () => {
    const { onCaughtError } = renderAt("/fleet", <Route path="/fleet" element={<Boom />} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("This page could not be shown.");
    await expectShellMounted();
    expect(onCaughtError).toHaveBeenCalledTimes(1);
  });

  it("shows the message in the shell when a lazy page's chunk fails to load", async () => {
    const Broken = lazy(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
    );
    renderAt("/fleet", <Route path="/fleet" element={<Broken />} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("This page could not be shown.");
    await expectShellMounted();
  });

  // React.lazy caches the rejection, so on a lazy route the retry is a
  // reload, never a re-render.
  it("reloads the page from its button off the driver's routes", async () => {
    const { reload } = renderAt("/fleet", <Route path="/fleet" element={<Boom />} />);

    await userEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The in-place arm, for the driver's static routes (RouteErrorBoundary's
  // retry, U54).
  it.each([
    ["/capture/v-1", "/capture/:vehicleId"],
    ["/my", "/my"],
    ["/my/", "/my"],
    ["/MY", "/my"],
    ["/Capture/v-1", "/capture/:vehicleId"],
    ["/%6Dy", "/my"],
  ])("tries again in place on %s, without a reload", async (path, pattern) => {
    pageBroken = true;
    const { reload } = renderAt(path, <Route path={pattern} element={<FlakyPage />} />);
    await screen.findByRole("alert");

    pageBroken = false;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Page resumed")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("clears when the user picks another page from the nav", async () => {
    renderAt(
      "/fleet",
      <>
        <Route path="/fleet" element={<Boom />} />
        <Route path="/fleet/tyres" element={<p>Tyre register</p>} />
      </>,
    );
    await screen.findByRole("alert");

    await userEvent.click(screen.getByRole("link", { name: "Tyres" }));

    expect(await screen.findByText("Tyre register")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells a driver on the capture route that their readings are kept", async () => {
    renderAt("/capture/v-1", <Route path="/capture/:vehicleId" element={<Boom />} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Readings already entered are kept on this phone.",
    );
  });

  it("says nothing about readings off the capture route", async () => {
    renderAt("/fleet", <Route path="/fleet" element={<Boom />} />);

    expect(await screen.findByRole("alert")).not.toHaveTextContent("Readings");
  });
});

describe("the capture error screen and the storage faults (TYRE-339)", () => {
  it("says the last readings may be missing after a degraded fault", async () => {
    writeFailed();
    renderAt("/capture/v-1", <Route path="/capture/:vehicleId" element={<Boom />} />);
    const shown = await errorScreen();
    expect(shown).toHaveTextContent(MAY_BE_MISSING);
    expect(shown).not.toHaveTextContent("kept on this phone");
  });

  it("says the same when the phone is also refusing to save", async () => {
    storageRefused();
    writeFailed();
    renderAt("/capture/v-1", <Route path="/capture/:vehicleId" element={<Boom />} />);
    expect(await errorScreen()).toHaveTextContent(MAY_BE_MISSING);
  });

  it("says nothing about readings when the phone refused before any inspection", async () => {
    storageRefused();
    renderAt("/capture/v-1", <Route path="/capture/:vehicleId" element={<Boom />} />);
    expect(await errorScreen()).not.toHaveTextContent(/readings/i);
  });

  // CaptureReview maps draft.warnings and the walk-around never reads it, so
  // this draft resumes and throws at review.
  it("does not say readings are kept after a failed write, and keeps the banner through Try again", async () => {
    const user = userEvent.setup();
    serveReads({ "/api/capture/vehicles/v1": captureContext() });
    await seedDraft({ patch: { warnings: {} } });
    renderAt("/capture/v1", capturePage());
    await user.click(await screen.findByRole("button", { name: /^Position 1,/ }));
    vi.spyOn(db.drafts, "put").mockRejectedValue(new Error("storage blocked"));
    await user.click(screen.getByRole("button", { name: "1" }));
    expect(await screen.findByText(DEGRADED)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: /review and submit/i }));

    const shown = await errorScreen();
    expect(shown).toHaveTextContent(MAY_BE_MISSING);
    expect(shown).not.toHaveTextContent("kept on this phone");

    await tryAgain(user);
    expect(await screen.findByText(DEGRADED)).toBeInTheDocument();
  });
});

const readsOf = (api: ReturnType<typeof serveReads>) =>
  api.mock.calls.map(([input]) => requestedUrl(input));

// rigPositions spreads positions, so the real capture page throws on this
// cached copy on every mount until a fetch replaces it.
const throwingContext = { ...captureContext(), positions: null } as unknown as CaptureContext;
const atNow = captureContextQuery("v1").queryKey;
const vehicle = "/api/capture/vehicles/v1";

function cachedThrowing(): QueryClient {
  const client = testQueryClient();
  client.setQueryData(atNow, throwingContext);
  return client;
}

// One read held open until the test answers it.
function holdReads() {
  let release: (body: unknown) => void = () => undefined;
  const held = new Promise<Response>((resolve) => {
    release = (body) => resolve(respond(200, body));
  });
  const api = vi.fn(() => held);
  vi.stubGlobal("fetch", api);
  return { api, answer: (body: unknown) => release(body) };
}

describe("the second failure in a row (TYRE-340)", () => {
  it("tries again at once on the first failure, and fetches the vehicle before the second", async () => {
    const user = userEvent.setup();
    const api = serveReads({ [vehicle]: captureContext() });
    renderAt("/capture/v1", capturePage(), { client: cachedThrowing() });

    const first = await errorScreen();
    expect(first).toHaveTextContent("This page could not be shown.");
    expect(first).not.toHaveTextContent("fetches a fresh copy");
    await tryAgain(user);
    const second = await errorScreen();
    expect(second).toHaveTextContent("This page still cannot be shown.");
    expect(second).toHaveTextContent(
      "Try again fetches a fresh copy first. Find signal if you can.",
    );
    expect(readsOf(api)).toEqual([]);

    await tryAgain(user);

    expect(await screen.findByRole("button", { name: /start inspection/i })).toBeInTheDocument();
    expect(readsOf(api)).toEqual([vehicle]);
  });

  it("keeps the copy when the fetch fails, and the page reads it again", async () => {
    const user = userEvent.setup();
    serveReads({});
    const client = cachedThrowing();
    const { onCaughtError } = renderAt("/capture/v1", capturePage(), { client });
    await tryAgain(user);
    await screen.findByText("This page still cannot be shown.");

    await tryAgain(user);

    await waitFor(() => expect(onCaughtError).toHaveBeenCalledTimes(3));
    expect(client.getQueryData(atNow)).toBe(throwingContext);
    expect(await errorScreen()).toHaveTextContent("This page still cannot be shown.");
  });

  // A wait on the paused fetch would run past waitFor's 5 s to the 10 s bound.
  it("does not hold the retry on a fetch that pauses offline", async () => {
    const user = userEvent.setup();
    serveReads({ [vehicle]: captureContext() });
    const { onCaughtError } = renderAt("/capture/v1", capturePage(), {
      client: cachedThrowing(),
    });
    await tryAgain(user);
    await screen.findByText("This page still cannot be shown.");
    onlineManager.setOnline(false);
    try {
      await tryAgain(user);
      await waitFor(() => expect(onCaughtError).toHaveBeenCalledTimes(3));
    } finally {
      onlineManager.setOnline(true);
    }
  });

  // What the driver sees while the retry waits. A second tap's guard is not
  // observable here: the library hands a second call the fetch in flight.
  it("holds Try again busy while the fetch is open, and recovers once when it lands", async () => {
    const user = userEvent.setup();
    const { answer } = holdReads();
    const { onCaughtError } = renderAt("/capture/v1", capturePage(), {
      client: cachedThrowing(),
    });
    await tryAgain(user);
    await screen.findByText("This page still cannot be shown.");
    await tryAgain(user);

    const busy = await screen.findByRole("button", { name: "Trying again…" });
    expect(busy).toHaveAttribute("aria-disabled", "true");
    await user.click(busy);
    expect(screen.getByRole("button", { name: "Trying again…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    answer(captureContext());

    expect(await screen.findByRole("button", { name: /start inspection/i })).toBeInTheDocument();
    expect(onCaughtError).toHaveBeenCalledTimes(2);
  });

  it("lets a navigation during the wait win, so the late fetch remounts nothing", async () => {
    const user = userEvent.setup();
    const { answer } = holdReads();
    const client = cachedThrowing();
    renderAt(
      "/capture/v1",
      <>
        {capturePage()}
        <Route path="/fleet/tyres" element={<FlakyPage />} />
      </>,
      { client },
    );
    await tryAgain(user);
    await screen.findByText("This page still cannot be shown.");
    await tryAgain(user);
    await screen.findByRole("button", { name: "Trying again…" });

    await user.click(screen.getByRole("link", { name: "Tyres" }));
    await screen.findByText("This page could not be shown.");
    pageBroken = false;
    answer(captureContext());
    await waitFor(() => expect(client.getQueryData(atNow)).not.toBe(throwingContext));
    // Past the data landing the retry is promise callbacks only, which all
    // run before the next timer fires.
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

    expect(screen.getByText("This page could not be shown.")).toBeInTheDocument();
    expect(screen.queryByText("Page resumed")).toBeNull();
  });

  // Spec 4: U148 and U182 hold a draft's windowed copy; this is the fetch a
  // cold reload of the same draft makes, for the same window.
  it("fetches a draft's windowed copy that was seeded and never fetched", async () => {
    const user = userEvent.setup();
    const startedAt = new Date(Date.now() - 3_600_000).toISOString();
    await seedDraft({ startedAt });
    const client = testQueryClient();
    const windowed = captureContextQuery("v1", startedAt, client, "Africa/Johannesburg");
    await client.ensureQueryData({ ...windowed, initialData: throwingContext });
    expect(client.getQueryState(windowed.queryKey)?.dataUpdateCount).toBe(0);
    const api = serveReads({ [vehicle]: captureContext() });
    renderAt("/capture/v1", capturePage(), { client });
    await tryAgain(user);
    await screen.findByText("This page still cannot be shown.");

    await tryAgain(user);

    expect(await screen.findAllByRole("button", { name: /^Position 1,/ })).not.toHaveLength(0);
    expect(readsOf(api)).toEqual([`${vehicle}?startedAt=${encodeURIComponent(startedAt)}`]);
  });

  // homeView spreads trip.trailers, so this cached trip throws in the real page.
  it("fetches the task list and the trip again on /my", async () => {
    const user = userEvent.setup();
    const client = testQueryClient();
    client.setQueryData(myTasksQuery().queryKey, []);
    client.setQueryData(myTripQuery().queryKey, {
      trip: { motive: { vehicleId: "h1", fleetNumber: "H1" }, trailers: null },
    });
    const api = serveReads({
      "/api/my/tasks": [],
      "/api/my/trip": { trip: { motive: { vehicleId: "h1", fleetNumber: "H1" }, trailers: [] } },
    });
    renderAt("/my", <Route path="/my" element={<DriverHome />} />, { client });
    await tryAgain(user);
    await screen.findByText("This page still cannot be shown.");
    expect(readsOf(api)).toEqual([]);

    await tryAgain(user);

    expect(await screen.findByRole("region", { name: "Your trip" })).toHaveTextContent("H1");
    expect(readsOf(api)).toEqual(expect.arrayContaining(["/api/my/tasks", "/api/my/trip"]));
  });
});
