import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { authChunk } from "../api/token";
import { page } from "../shell/chunkReload";
import { db } from "./draft";
import type { OutboxEntry } from "./outbox";
import { OutboxIndicator } from "./OutboxIndicator";
import type { SubmitPayload } from "./payload";

// The sign-in chunk fails to load, as it does behind a captive portal; Chrome
// and released Safari then fail every later import on the page (TYRE-381).
vi.mock("../auth/oidc", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

const outbox = () => db.table<OutboxEntry, string>("outbox");

const held: OutboxEntry = {
  clientUuid: "held-1",
  state: "queued",
  payload: { client_uuid: "held-1", readings: [] } as unknown as SubmitPayload,
  queuedAt: Date.now(),
  attempts: 1,
  nextAttemptAt: Date.now() + 3_600_000,
  lastStatus: null,
  lastCode: null,
  lastError: "Failed to fetch dynamically imported module",
  fleetNumber: "BAC 101",
  driverSubject: "oid-driver-1",
  legacy: false,
};

beforeEach(async () => {
  await db.open();
  await outbox().clear();
  await outbox().put(held);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  await outbox().clear();
});

// First: the chunk's failure is module state, and the next case sets it.
it("does not reload on Sync now while the chunk has not failed", async () => {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
  const reload = vi.spyOn(page, "reload").mockImplementation(() => undefined);
  render(<OutboxIndicator />);

  await userEvent.setup().click(await screen.findByRole("button", { name: "Sync now" }));

  expect(reload).not.toHaveBeenCalled();
});

// U174: with work held neither Sign in nor Sign out is on screen, so Sync now
// is the tap that reloads, once, after the chunk has failed.
it("reloads on Sync now once the sign-in chunk has failed to load", async () => {
  vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
  const reload = vi.spyOn(page, "reload").mockImplementation(() => undefined);
  await authChunk().catch(() => undefined);
  render(<OutboxIndicator />);

  await userEvent.setup().click(await screen.findByRole("button", { name: "Sync now" }));

  expect(reload).toHaveBeenCalledTimes(1);
});
