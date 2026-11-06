import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ActorContext } from "../auth/actorContext";
import { me } from "../test/fixtures";
import { expectNothingForbiddenSpoken } from "../test/spoken";
import { db } from "./draft";
import type { OutboxEntry, OutboxState } from "./outbox";
import { CLOCK_AHEAD_COPY } from "./outbox";
import { OutboxIndicator } from "./OutboxIndicator";
import type { SubmitPayload } from "./payload";

// nextAttemptAt is always in the future on a queued fixture: this component
// flushes on mount (FR-OFF-009), and a due entry would be sent and never
// counted.
function entry(
  clientUuid: string,
  state: OutboxState,
  fleetNumber: string | null = null,
): OutboxEntry {
  return {
    clientUuid,
    state,
    payload: { client_uuid: clientUuid, readings: [] } as unknown as SubmitPayload,
    queuedAt: Date.now(),
    attempts: 0,
    nextAttemptAt: Date.now() + 3_600_000,
    lastStatus: null,
    lastCode: null,
    lastError: null,
    fleetNumber,
    driverSubject: "oid-driver-1",
    legacy: false,
  };
}

const outbox = () => db.table<OutboxEntry, string>("outbox");

// A start that fails, as it does with no signal, so the failure line shows.
vi.mock("../auth/oidc", () => ({
  signIn: vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
}));

beforeEach(async () => {
  await db.open();
  await outbox().clear();
  // The fixtures are stamped for this driver, and the band words another
  // driver's entry apart (U104).
  window.localStorage.setItem("tyre.dev.user-id", "oid-driver-1");
  // The heartbeat and the mount flush both reach the network otherwise.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  await outbox().clear();
});

describe("OutboxIndicator", () => {
  it("renders nothing while the queue is empty", async () => {
    const { container } = render(<OutboxIndicator />);
    // Awaited rather than asserted synchronously: the subscription's first
    // emission is async, so a bare assertion would pass before it arrived and
    // could not tell "empty" from "not subscribed yet".
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(container).toBeEmptyDOMElement();
  });

  // The one assertion the hand-rolled useSyncExternalStore exists for: the
  // entry is written after mount, and a mount-time-only read would show an
  // empty queue for the rest of the session.
  it("counts an inspection queued after it mounted", async () => {
    render(<OutboxIndicator />);
    expect(screen.queryByRole("status")).toBeNull();

    await outbox().put(entry("u1", "queued"));

    expect(await screen.findByText(/1 inspection waiting to send/i)).toBeInTheDocument();
  });

  it("drops the count again when the queue drains", async () => {
    await outbox().put(entry("u1", "queued"));
    const { container } = render(<OutboxIndicator />);
    await screen.findByText(/1 inspection waiting to send/i);

    await outbox().delete("u1");

    await vi.waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  // NFR-USE-009: the count is in words, so the grammar has to be right;
  // driver-facing copy is part of the product, not decoration.
  it("agrees with itself about number in both directions", async () => {
    await outbox().put(entry("u1", "failed"));
    render(<OutboxIndicator />);
    expect(await screen.findByText(/^1 inspection needs the office$/)).toBeInTheDocument();

    await outbox().put(entry("u2", "failed"));
    expect(await screen.findByText(/^2 inspections need the office$/)).toBeInTheDocument();
  });

  // FR-OFF-013: a permanent refusal is not "waiting to send". Nothing will
  // happen to it without a person, and counting it among the waiting leaves a
  // driver watching a queue that can never drain.
  it("separates what is waiting from what needs a person", async () => {
    await outbox().put(entry("u1", "queued"));
    await outbox().put(entry("u2", "failed"));
    render(<OutboxIndicator />);

    expect(await screen.findByText(/1 inspection waiting to send/i)).toBeInTheDocument();
    expect(screen.getByText(/1 inspection needs the office/i)).toBeInTheDocument();
  });

  // FR-OFF-020: approximately two days is when iOS eviction becomes a real
  // risk, and at that point the driver has to be told to go and find signal.
  it("says so when an inspection has been waiting over two days", async () => {
    await outbox().put({ ...entry("u1", "queued"), queuedAt: Date.now() - 49 * 3_600_000 });
    render(<OutboxIndicator />);

    expect(await screen.findByText(/waiting over two days/i)).toBeInTheDocument();
  });

  // The account, the token store or the server holds these, so after two
  // days the line warns, naming that cause, not signal.
  it.each([
    [403, "tenant_inactive", "This company's account is not active. Contact your fleet office."],
    [403, "not_provisioned", "Ask your fleet office to set up your account."],
    [503, "auth_unavailable", "Sign-in is unavailable right now. Try again shortly."],
    [500, null, "The server could not take it yet. It will send by itself."],
  ])("names what holds a %i %s entry after two days", async (status, code, sentence) => {
    await outbox().put({
      ...entry("u1", "queued"),
      queuedAt: Date.now() - 49 * 3_600_000,
      lastStatus: status,
      lastCode: code,
    });
    render(<OutboxIndicator />);

    expect(await screen.findByText(`Waiting over two days. ${sentence}`)).toBeInTheDocument();
    expect(screen.queryByText(/find signal/i)).toBeNull();
  });

  // The clock has a line of its own, so this driver's stale TY021 entry
  // prefixes that line rather than repeating it.
  it("prefixes the clock line for a stale TY021 entry, once", async () => {
    await outbox().put({
      ...entry("u1", "queued"),
      queuedAt: Date.now() - 49 * 3_600_000,
      lastStatus: 422,
      lastCode: "TY021",
    });
    render(<OutboxIndicator />);

    expect(
      await screen.findByText(`Waiting over two days. ${CLOCK_AHEAD_COPY}`),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/clock is ahead/)).toHaveLength(1);
  });

  // TYRE-167: the "needs the office" line stops being permanent. Two taps,
  // on the shell banner, only for a refused entry. A queued one shows no
  // such control.
  it("lets the driver hand a refused inspection to the office and drop it", async () => {
    const user = userEvent.setup();
    await outbox().put(entry("u-failed", "failed"));
    const { container } = render(<OutboxIndicator />);

    await screen.findByText(/needs the office/);
    // The sweep runs while the new strings are on screen: once the drop
    // completes the indicator unmounts entirely, so nothing is left in
    // container for a post-drop sweep.
    expectNothingForbiddenSpoken(container, /office/i);
    await user.click(screen.getByRole("button", { name: /the office has this one/i }));
    expect(screen.getByRole("group", { name: /remove this inspection/i })).toHaveTextContent(
      /the office must already have/i,
    );
    expectNothingForbiddenSpoken(container, /office/i);
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(async () => expect(await outbox().count()).toBe(0));
  });

  it("offers no removal for an inspection still waiting to send", async () => {
    await outbox().put(entry("u-queued", "queued"));
    render(<OutboxIndicator />);
    await screen.findByText(/waiting to send/);
    expect(screen.queryByRole("button", { name: /the office has this one/i })).toBeNull();
  });

  // TYRE-215: a skew refusal is named for what it is, with the fix, instead
  // of "needs the office".
  it("tells the driver the phone clock is ahead when that is why it has not sent", async () => {
    await outbox().put({ ...entry("u-skew", "queued"), lastCode: "TY021", attempts: 1 });
    const { container } = render(<OutboxIndicator />);
    const line = await screen.findByText(/clock is ahead/i);
    expect(line).toHaveTextContent(/check the time/i);
    expectNothingForbiddenSpoken(container, /clock is ahead/i);
  });

  // TYRE-167: a duplicate accessible name across two failed entries is a
  // mis-click away from deleting the wrong never-synced inspection, so the
  // release control must name the vehicle it releases.
  it("names the vehicle so two failed entries can be told apart", async () => {
    const user = userEvent.setup();
    await outbox().put(entry("u-101", "failed", "BAC 101"));
    await outbox().put(entry("u-202", "failed", "BAC 202"));
    const { container } = render(<OutboxIndicator />);

    await screen.findByRole("button", { name: /the office has bac 101/i });
    screen.getByRole("button", { name: /the office has bac 202/i });
    expectNothingForbiddenSpoken(container, /bac 101/i);

    await user.click(screen.getByRole("button", { name: /the office has bac 101/i }));
    await user.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(async () => expect(await outbox().count()).toBe(1));
    const [remaining] = await outbox().toArray();
    expect(remaining.clientUuid).toBe("u-202");
    expect(screen.getByRole("button", { name: /the office has bac 202/i })).toBeInTheDocument();
    expect(screen.queryByText("Could not remove it. Try again.")).toBeNull();
  });

  // TYRE-218: IndexedDB can refuse the delete. The entry stays, so the
  // driver is told on that entry's line why the tap did nothing, and the
  // next tap tries again.
  it("says so on the entry's line when the phone refuses to remove it", async () => {
    const user = userEvent.setup();
    await outbox().put(entry("u-101", "failed", "BAC 101"));
    await outbox().put(entry("u-202", "failed", "BAC 202"));
    const refused = vi.spyOn(outbox(), "delete").mockRejectedValueOnce(new Error("blocked"));
    try {
      render(<OutboxIndicator />);
      await user.click(await screen.findByRole("button", { name: "The office has BAC 101" }));
      await user.click(screen.getByRole("button", { name: "Remove" }));

      const line = await screen.findByText("Could not remove it. Try again.");
      expect(screen.getAllByText("Could not remove it. Try again.")).toHaveLength(1);
      const group = screen.getByRole("group", { name: /remove this inspection/i });
      expect(group.parentElement).toContainElement(line);
      expect(await outbox().count()).toBe(2);

      await user.click(screen.getByRole("button", { name: "Remove" }));
      await waitFor(async () => expect(await outbox().count()).toBe(1));
      expect(screen.queryByText("Could not remove it. Try again.")).toBeNull();
      expect(screen.getByRole("button", { name: "The office has BAC 202" })).toBeInTheDocument();
    } finally {
      refused.mockRestore();
    }
  });

  // NFR-USE-010, ADR-0009: what is stuck, and the way to unstick it, show
  // with nothing to open first. A disclosure or a chip that folded them away
  // would leave a driver in the sun reading "all fine". jsdom applies no
  // stylesheet, so this pins the markup: no hidden attribute, no closed
  // details around any of them.
  it("stale and failed lines and Sync now are visible", async () => {
    window.localStorage.setItem("tyre.dev.auth", "bearer");
    window.localStorage.setItem("tyre.auth.subject", "oid-driver-1");
    try {
      await outbox().put({ ...entry("u-stale", "queued"), queuedAt: Date.now() - 49 * 3_600_000 });
      await outbox().put({ ...entry("u-held", "queued"), lastStatus: 401 });
      await outbox().put(entry("u-failed", "failed", "SBX 101"));
      render(<OutboxIndicator />);

      const shown = [
        await screen.findByText("Waiting over two days. Please find signal and sync."),
        screen.getByText("2 inspections waiting to send"),
        screen.getByText("1 inspection needs the office"),
        screen.getByRole("button", { name: "The office has SBX 101" }),
        screen.getByText("Sign in to send 1 inspection"),
        screen.getByRole("button", { name: "Sign in" }),
        screen.getByRole("button", { name: "Sync now" }),
      ];
      for (const element of shown) {
        expect(element).toBeVisible();
        expect(element.closest("details:not([open])")).toBeNull();
      }
    } finally {
      window.localStorage.clear();
    }
  });

  // FR-OFF-010: the tap sends what is still waiting out its retry delay,
  // which the mount flush leaves for later.
  it("sends an inspection that is still backing off when Sync now is tapped", async () => {
    window.localStorage.setItem("tyre.dev.user-id", "oid-driver-1");
    try {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ inspectionId: "i-1" }), { status: 201 }),
      );
      await outbox().put(entry("u-backoff", "queued"));
      render(<OutboxIndicator />);
      await screen.findByText("1 inspection waiting to send");
      expect(fetch).not.toHaveBeenCalled();

      await userEvent.setup().click(screen.getByRole("button", { name: "Sync now" }));

      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(vi.mocked(fetch).mock.calls[0][0]).toBe("/api/inspections");
    } finally {
      window.localStorage.clear();
    }
  });
});

describe("the sign-in line", () => {
  beforeEach(() => {
    window.localStorage.setItem("tyre.dev.auth", "bearer");
    window.localStorage.setItem("tyre.auth.subject", "oid-driver-1");
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  // A stale entry this driver can sign in for prefixes the sign-in line.
  it("prefixes the sign-in line for this driver's stale entry, once", async () => {
    await outbox().put({
      ...entry("u1", "queued"),
      queuedAt: Date.now() - 49 * 3_600_000,
      lastStatus: 401,
    });
    render(<OutboxIndicator />);

    expect(
      await screen.findByText("Waiting over two days. Sign in to send 1 inspection"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Sign in to send it/)).toBeNull();
  });

  // Another driver's held entry waits for them (U104), so this driver is not
  // told to sign in for it.
  it("asks for the capturing driver's sign-in on another driver's stale entry", async () => {
    window.localStorage.setItem("tyre.auth.subject", "oid-driver-2");
    await outbox().put({
      ...entry("u1", "queued"),
      queuedAt: Date.now() - 49 * 3_600_000,
      lastStatus: 401,
    });
    render(<OutboxIndicator />);

    expect(
      await screen.findByText(
        "Waiting over two days. The driver who captured it needs to sign in here to send it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Sign in to send/)).toBeNull();
  });

  // U104: sendEntry sends nothing mayCarry refuses, so another driver's entry
  // waits on their sign-in whatever hold it last met.
  it.each([
    [null, null],
    [503, null],
    [422, "TY021"],
    [403, "tenant_inactive"],
  ])(
    "asks for the capturing driver's sign-in on another driver's stale entry held by %s %s",
    async (status, code) => {
      window.localStorage.setItem("tyre.auth.subject", "oid-driver-2");
      await outbox().put({
        ...entry("u1", "queued"),
        queuedAt: Date.now() - 49 * 3_600_000,
        lastStatus: status,
        lastCode: code,
      });
      render(<OutboxIndicator />);

      await screen.findByText("1 inspection waiting to send");
      expect(screen.getAllByText(/Waiting over two days/).map((line) => line.textContent)).toEqual([
        "Waiting over two days. The driver who captured it needs to sign in here to send it.",
      ]);
      expect(screen.queryByText(/clock is ahead/)).toBeNull();
    },
  );

  // The U104 undo leaves nobody signed in, and the next to open the app is
  // usually the phone's owner (U115), so the line names no other driver.
  it.each([[401], [null]])(
    "names no other driver for a stale %s entry while nobody is signed in",
    async (status) => {
      window.localStorage.removeItem("tyre.auth.subject");
      await outbox().put({
        ...entry("u1", "queued"),
        queuedAt: Date.now() - 49 * 3_600_000,
        lastStatus: status,
      });
      render(
        <ActorContext.Provider value={{ actor: null, settled: true, failure: "signed-out" }}>
          <OutboxIndicator />
        </ActorContext.Provider>,
      );

      await screen.findByText("1 inspection waiting to send");
      expect(screen.getAllByText(/Waiting over two days/).map((line) => line.textContent)).toEqual([
        "Waiting over two days. The driver who captured it needs to sign in here to send it.",
      ]);
      expect(screen.queryByText(/Another driver/)).toBeNull();
    },
  );

  // The clock line says the entry will send later, which another driver's
  // will not without their sign-in.
  it("leaves another driver's TY021 entry off the clock line", async () => {
    window.localStorage.setItem("tyre.auth.subject", "oid-driver-2");
    await outbox().put({ ...entry("u1", "queued"), lastStatus: 422, lastCode: "TY021" });
    render(<OutboxIndicator />);

    await screen.findByText("1 inspection waiting to send");
    expect(screen.queryByText(/clock is ahead/)).toBeNull();
  });

  // FR-OFF-020: a stale entry's warning is an alert on every line it prefixes.
  it("warns with an alert when this driver's stale entry waits on a sign-in", async () => {
    await outbox().put({
      ...entry("u1", "queued"),
      queuedAt: Date.now() - 49 * 3_600_000,
      lastStatus: 401,
    });
    render(<OutboxIndicator />);

    const line = await screen.findByText("Waiting over two days. Sign in to send 1 inspection");
    expect(line).toHaveAttribute("role", "alert");
    expect(line).toHaveClass("cap-outbox-line--stop");
  });

  it("asks this driver to sign in to send what a 401 is holding", async () => {
    await outbox().put({ ...entry("u1", "queued"), lastStatus: 401 });
    render(<OutboxIndicator />);
    expect(await screen.findByText("Sign in to send 1 inspection")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });

  // The band's lines are read on every change. Inside them, the action's
  // label would be read with each one and its alert nested in the status.
  it("keeps the sign-in action and its failure line outside the band's live region", async () => {
    await outbox().put({ ...entry("u1", "queued"), lastStatus: 401 });
    render(<OutboxIndicator />);
    await screen.findByText("Sign in to send 1 inspection");
    const button = screen.getByRole("button", { name: "Sign in" });
    await userEvent.setup().click(button);
    const failure = await screen.findByText("Could not start sign-in. Find signal and try again.");

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Sign in to send 1 inspection");
    expect(status).not.toContainElement(button);
    expect(status).not.toContainElement(failure);
  });

  // One 401-held entry each for this driver and another. The line counts only
  // this driver's (U104).
  it("counts only this driver's held work", async () => {
    await outbox().put({ ...entry("u1", "queued"), lastStatus: 401 });
    await outbox().put({ ...entry("u2", "queued"), lastStatus: 401, driverSubject: "oid-other" });
    render(<OutboxIndicator />);
    await screen.findByText(/2 inspections waiting to send/);
    expect(screen.getByText("Sign in to send 1 inspection")).toBeInTheDocument();
  });

  // The shell mounts the indicator above AuthGate, so the sign-in screen
  // already carries the count and the button (spec section 4).
  it.each(["signed-out", "not-set-up", "tenant-inactive", "unavailable"] as const)(
    "stays quiet while the %s gate screen is showing",
    async (failure) => {
      await outbox().put({ ...entry("u1", "queued"), lastStatus: 401 });
      render(
        <ActorContext.Provider value={{ actor: null, settled: true, failure }}>
          <OutboxIndicator />
        </ActorContext.Provider>,
      );
      await screen.findByText(/1 inspection waiting to send/);
      expect(screen.queryByText(/Sign in to send/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    },
  );

  it("still offers the sign-in when the page has an actor and a later 401 holds work", async () => {
    await outbox().put({ ...entry("u1", "queued"), lastStatus: 401 });
    render(
      <ActorContext.Provider value={{ actor: me(), settled: true, failure: "signed-out" }}>
        <OutboxIndicator />
      </ActorContext.Provider>,
    );
    expect(await screen.findByText("Sign in to send 1 inspection")).toBeInTheDocument();
  });
});
