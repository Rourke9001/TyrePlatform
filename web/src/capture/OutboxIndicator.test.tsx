import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { db } from "./draft";
import type { OutboxEntry, OutboxState } from "./outbox";
import { OutboxIndicator } from "./OutboxIndicator";
import type { SubmitPayload } from "./payload";

// nextAttemptAt is deliberately in the future on every queued fixture: this
// component calls flushOutbox() on mount (FR-OFF-009), and an entry that is due
// would be sent, deleted and never counted. A failed entry is skipped by
// attemptSend without the guard.
function entry(clientUuid: string, state: OutboxState): OutboxEntry {
  return {
    clientUuid,
    state,
    payload: { client_uuid: clientUuid, readings: [] } as unknown as SubmitPayload,
    queuedAt: Date.now(),
    attempts: 0,
    nextAttemptAt: Date.now() + 3_600_000,
    lastStatus: null,
    lastError: null,
  };
}

const outbox = () => db.table<OutboxEntry, string>("outbox");

beforeEach(async () => {
  await db.open();
  await outbox().clear();
  // The heartbeat and the mount flush both reach the network otherwise.
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
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

  // The one assertion the hand-rolled useSyncExternalStore exists for. The
  // entry is written AFTER mount, with nothing telling this component about
  // it — a mount-time read would show an empty queue for the rest of the
  // session, which is precisely how a driver ends up watching nothing.
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

  // NFR-USE-009: the count is in words, so the words have to be right. The
  // noun and the verb both inflect, and a plural verb on a singular noun is
  // the kind of thing that quietly costs a pilot its credibility —
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
});
