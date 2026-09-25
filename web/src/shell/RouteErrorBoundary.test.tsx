import { lazy, Suspense, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActorContext } from "../auth/actorContext";
import { db } from "../capture/draft";
import type { OutboxEntry } from "../capture/outbox";
import type { SubmitPayload } from "../capture/payload";
import { AppShell } from "../dashboard/AppShell";
import { me } from "../test/fixtures";
import { deriveBrandTheme } from "../theme/derive";
import { ThemeContext } from "../theme/themeContext";
import { RouteErrorBoundary } from "./RouteErrorBoundary";

const branding = { displayName: "Sandbox Fleet", primaryColor: "#1F7A5A", logoUrl: null };
const outbox = () => db.table<OutboxEntry, string>("outbox");

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
function renderAt(path: string, routes: ReactNode) {
  const reload = vi.fn();
  const onCaughtError = vi.fn();
  render(
    <ThemeContext value={{ branding, theme: deriveBrandTheme(branding.primaryColor) }}>
      <ActorContext
        value={{
          actor: me({ displayName: "Controller", capabilities: ["ViewFleet", "ManageAssets"] }),
          settled: true,
        }}
      >
        <MemoryRouter initialEntries={[path]}>
          <AppShell>
            <RouteErrorBoundary reload={reload}>
              <Suspense fallback={<p>Loading.</p>}>
                <Routes>{routes}</Routes>
              </Suspense>
            </RouteErrorBoundary>
          </AppShell>
        </MemoryRouter>
      </ActorContext>
    </ThemeContext>,
    { onCaughtError },
  );
  return { reload, onCaughtError };
}

beforeEach(async () => {
  await db.open();
  await outbox().clear();
  await outbox().put(queued("u-1"));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await outbox().clear();
});

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

  // React.lazy caches the rejection, so off the capture route the retry is a
  // reload, never a re-render.
  it("reloads the page from its button off the capture route", async () => {
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
