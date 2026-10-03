import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { credential, SUBJECT_KEY } from "../api/token";
import { db } from "../capture/draft";
import type { OutboxEntry } from "../capture/outbox";
import { OutboxIndicator } from "../capture/OutboxIndicator";
import type { SubmitPayload } from "../capture/payload";
import { bearerSession } from "../test/bearerSession";
import { me } from "../test/fixtures";
import { ActorContext } from "./actorContext";
import { SignInLine } from "./SignInLine";
import authCss from "./auth.css?raw";

// A renewal that finds no session, which lapses the token store.
vi.mock("./oidc", () => ({ renew: vi.fn(() => Promise.resolve(null)) }));

const LAPSED = "Your sign-in has run out. Sign in to carry on.";

beforeEach(async () => {
  window.localStorage.clear();
  bearerSession();
  await db.open();
  await db.table("outbox").clear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  await db.table("outbox").clear();
});

async function lapse() {
  await act(async () => {
    await credential().catch(() => undefined);
  });
}

// The region is in the accessibility tree before the lapse, so the lapse is an
// update a screen reader announces. The button sits outside it, so its label
// is not read as part of the status. Vitest loads no stylesheet, so auth.css
// is put in the document.
it("announces a lapse through a status region already in the tree, with the button outside it", async () => {
  const style = document.createElement("style");
  style.textContent = authCss;
  document.head.append(style);
  try {
    render(
      <ActorContext value={{ actor: me(), settled: true }}>
        <SignInLine />
      </ActorContext>,
    );
    const region = screen.getByRole("status");
    expect(region).toHaveTextContent("");
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();

    await lapse();

    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent(LAPSED);
    expect(region).not.toContainElement(screen.getByRole("button", { name: "Sign in" }));
  } finally {
    style.remove();
  }
});

// Backed off past the test, so the band's mount flush sends nothing.
function held(clientUuid: string, driverSubject: string, lastStatus: number | null): OutboxEntry {
  return {
    clientUuid,
    state: "queued",
    payload: { client_uuid: clientUuid, readings: [] } as unknown as SubmitPayload,
    queuedAt: Date.now(),
    attempts: 1,
    nextAttemptAt: Date.now() + 3_600_000,
    lastStatus,
    lastCode: null,
    lastError: null,
    fleetNumber: null,
    driverSubject,
    legacy: false,
  };
}

// The shell's order (AppShell): the outbox band, then the line.
function shell() {
  return render(
    <ActorContext value={{ actor: me(), settled: true }}>
      <OutboxIndicator />
      <SignInLine />
    </ActorContext>,
  );
}

// U107: a lapsed session shows one "Sign in". While the band offers one, its
// line names the work the sign-in unblocks.
describe("beside the outbox band", () => {
  beforeEach(() => {
    window.localStorage.setItem(SUBJECT_KEY, "oid-a");
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
    );
  });

  it("is hidden while the band offers to sign in and send this driver's work", async () => {
    await db.table("outbox").put(held("u1", "oid-a", 401));
    shell();
    await lapse();

    expect(await screen.findByText(/Sign in to send 1/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
    expect(screen.queryByText(LAPSED)).toBeNull();
  });

  it("still shows when nothing of this driver's is held on a 401", async () => {
    await db.table("outbox").bulkPut([held("u1", "oid-a", null), held("u2", "oid-b", 401)]);
    shell();
    await lapse();

    expect(await screen.findByText(/2 inspections waiting to send/)).toBeInTheDocument();
    expect(screen.queryByText(/Sign in to send/)).toBeNull();
    expect(screen.getByText(LAPSED)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Sign in" })).toHaveLength(1);
  });
});
