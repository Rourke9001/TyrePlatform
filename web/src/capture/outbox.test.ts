import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client";
import { clearDraft, db, loadDraft, savePosition, startDraft } from "./draft";
import {
  attemptSend,
  backoffMs,
  classify,
  isStale,
  listOutbox,
  queueDraft,
  startOutboxHeartbeat,
} from "./outbox";

const meta = { granularityMm: 1.0, deviceId: "device-1", appVersion: "0.0.0", totalPositions: 1 };

beforeEach(async () => {
  await db.open();
  await clearDraft();
  await db.table("outbox").clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Belt-and-braces against the heartbeat test: fake timers left active by a
  // failure before its own vi.useRealTimers() would otherwise hang db.open()
  // in every beforeEach that follows, misattributing the break to whatever
  // test happens to run next.
  vi.useRealTimers();
});

async function queueOne() {
  await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:12:00Z" });
  await savePosition({
    positionId: "p1",
    vehicleId: "v1",
    tyreId: null,
    treads: [13, 13, 14],
    pressureKpa: 800,
    pressureTemperature: "COLD",
    damageFlag: false,
    note: null,
    seconds: 6,
    warnings: [],
  });
  return queueDraft({ ...meta, submittedAt: "2026-08-25T06:14:40Z" });
}

describe("classify", () => {
  // FR-OFF-013: a permanent failure needs a person, and the driver must be
  // told now rather than after thirty minutes of silent retrying.
  it("treats the duplicate-window refusal as permanent", () => {
    expect(classify(new ApiError(409, "x"))).toBe("permanent");
  });

  it("treats an unprocessable payload as permanent", () => {
    expect(classify(new ApiError(422, "x"))).toBe("permanent");
  });

  it("treats a refused actor as permanent", () => {
    expect(classify(new ApiError(403, "x"))).toBe("permanent");
  });

  // A body the server could not parse will not become parseable by waiting.
  it("treats a malformed body as permanent", () => {
    expect(classify(new ApiError(400, "x"))).toBe("permanent");
  });

  // FR-OFF-012: everything else is the network or the server, and both come
  // back. Rate limiting especially (NFR-SEC-007) — a 429 is a "later", not a
  // "never".
  it("treats a server fault, a rate limit and a dead network as retryable", () => {
    expect(classify(new ApiError(500, "x"))).toBe("retryable");
    expect(classify(new ApiError(429, "x"))).toBe("retryable");
    expect(classify(new TypeError("Failed to fetch"))).toBe("retryable");
  });

  // 401 is deliberately NOT permanent, though it shares its middleware with
  // 403. An expired session is recovered by signing in, and the queue then
  // drains; treating it as permanent would throw away a completed inspection
  // because a token timed out. 403 differs in kind — a capability is not
  // acquired by waiting.
  it("treats an expired session as retryable", () => {
    expect(classify(new ApiError(401, "unauthorized"))).toBe("retryable");
  });
});

describe("backoffMs", () => {
  it("grows exponentially", () => {
    expect(backoffMs(0)).toBeLessThan(backoffMs(1));
    expect(backoffMs(1)).toBeLessThan(backoffMs(2));
  });

  // FR-OFF-012's ceiling, exactly.
  it("never exceeds thirty minutes", () => {
    for (const attempt of [5, 10, 50, 1000]) {
      expect(backoffMs(attempt)).toBeLessThanOrEqual(30 * 60 * 1000);
    }
    expect(backoffMs(1000)).toBe(30 * 60 * 1000);
  });

  // The cap first engages at attempt 9. Testing only a large attempt count
  // pins the ceiling's value but not the exponent that reaches it.
  it("caps at the ninth attempt and not the eighth", () => {
    expect(backoffMs(8)).toBe(1_280_000);
    expect(backoffMs(9)).toBe(1_800_000);
  });
});

describe("the outbox", () => {
  // FR-OFF-005: the draft moves to the queue, and the two never both hold it
  // or neither does. One transaction, or an inspection can vanish between
  // them — which FR-OFF-014 forbids outright.
  it("moves the draft to the queue atomically", async () => {
    await queueOne();
    expect(await listOutbox()).toHaveLength(1);
    expect(await db.drafts.get("current")).toBeUndefined();
  });

  it("releases the entry on a 201", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: () => Promise.resolve({ inspectionId: "i1" }),
      }),
    );
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);

    expect(await listOutbox()).toHaveLength(0);
  });

  // FR-OFF-011: the outbox replays anything it did not clearly hear an answer
  // to, so a 200 replay has to release the entry exactly as a 201 does.
  it("releases the entry on a replay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ inspectionId: "i1" }),
      }),
    );
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);

    expect(await listOutbox()).toHaveLength(0);
  });

  it("keeps the entry and schedules a retry on a server fault", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) }),
    );
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);

    const [queued] = await listOutbox();
    expect(queued.state).toBe("queued");
    expect(queued.attempts).toBe(1);
    expect(queued.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  // FR-OFF-013: preserved locally, presented to the user, with a recovery
  // action — never retried into the void and never dropped.
  it("stops retrying a permanent refusal but keeps the inspection", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: () => Promise.resolve({}) }),
    );
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);

    const [failed] = await listOutbox();
    expect(failed.state).toBe("failed");
    expect(failed.lastStatus).toBe(409);
    // FR-OFF-014, the load-bearing half: the readings are still here.
    expect(failed.payload.readings).toHaveLength(1);
  });

  it("does not send an entry before its backoff has elapsed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);
    await attemptSend(entry.clientUuid);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // FR-OFF-010: the driver can always force it, whatever the backoff says.
  // FR-OFF-012: the schedule needs a pulse, or a 500 taken while online is
  // never retried at all.
  it("retries on the heartbeat once the backoff has elapsed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
    const entry = await queueOne();
    await attemptSend(entry.clientUuid);

    // Only the interval and the clock are faked: Dexie schedules its own
    // internal microtasks against the real setTimeout, and faking that queue
    // too deadlocks every IndexedDB operation for the rest of the test.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    const stop = startOutboxHeartbeat(1000);
    await vi.advanceTimersByTimeAsync(backoffMs(1) + 2000);
    // The heartbeat's flushOutbox is fire-and-forget, and fake-indexeddb
    // completes a request on a real (unfaked) timer tick, so the fake clock
    // advance above does not itself wait for it to finish.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    stop();
    vi.useRealTimers();
  });

  it("sends immediately when the driver asks", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", fetchMock);
    const entry = await queueOne();

    await attemptSend(entry.clientUuid);
    await attemptSend(entry.clientUuid, { force: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // 000023 refuses an empty readings array (TY005 -> 422), which the
  // classifier reads as permanent — so queueing one would strand a draft the
  // driver can still finish in a queue that can never drain (FR-OFF-014,
  // SRS Appendix H).
  it("refuses to queue an inspection with nothing completed, and keeps the draft", async () => {
    await startDraft({
      vehicleId: "v-horse",
      taskId: null,
      startedAt: "2026-08-25T06:12:00Z",
      combinationId: null,
    });
    await savePosition({
      positionId: "p1",
      vehicleId: "v-horse",
      tyreId: null,
      treads: [12, null, null],
      pressureKpa: null,
      pressureTemperature: "UNKNOWN",
      damageFlag: false,
      note: null,
      seconds: 2,
      warnings: [],
    });
    await expect(queueDraft({ ...meta, submittedAt: "2026-08-25T06:14:40Z" })).rejects.toThrow(
      "No completed positions",
    );
    // The rollback is the assertion that matters: without it the driver's
    // partial walk-around is gone.
    expect(await loadDraft()).toBeDefined();
    expect(await listOutbox()).toHaveLength(0);
  });
});

describe("isStale", () => {
  // FR-OFF-020: roughly two days, because on iOS an unsynced buffer is
  // genuinely at risk of eviction by then.
  it("is quiet for a day and warns after two", () => {
    const now = Date.parse("2026-08-25T06:00:00Z");
    expect(isStale({ queuedAt: now - 24 * 3600_000 }, now)).toBe(false);
    expect(isStale({ queuedAt: now - 49 * 3600_000 }, now)).toBe(true);
  });

  // 48h to the millisecond. The pair is the test: one either side of the
  // constant is what proves both the >= and the value, which a 24h/49h pair
  // cannot do.
  it("is not yet stale one millisecond before the threshold", () => {
    const now = Date.now();
    expect(isStale({ queuedAt: now - 172_799_999 }, now)).toBe(false);
  });

  it("is stale at exactly the threshold", () => {
    const now = Date.now();
    expect(isStale({ queuedAt: now - 172_800_000 }, now)).toBe(true);
  });
});
