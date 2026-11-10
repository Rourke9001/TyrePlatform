import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A short bound, so a stalled request ends in a test's time. The API client
// takes its bound from deadline() (deadline.ts).
vi.mock("../api/deadline", async (importOriginal) => {
  const real = await importOriginal<typeof import("../api/deadline")>();
  return { ...real, deadline: (what?: string) => real.deadline(what, 50) };
});

vi.mock("../auth/oidc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth/oidc")>()),
  renew: vi.fn(),
  signIn: vi.fn(),
  completeSignIn: vi.fn(),
  signOut: vi.fn(),
  discardUser: vi.fn(() => Promise.resolve()),
}));

import { clearDevActorId, setDevActorId } from "../api/devTenant";
import { SUBJECT_KEY } from "../api/token";
import { renew } from "../auth/oidc";
import { bearerSession } from "../test/bearerSession";
import { plantSession } from "../test/librarySession";
import { clearDraft, db, savePosition, startDraft } from "./draft";
import { attemptSend, discardEntry, flushOutbox, listOutbox, queueDraft } from "./outbox";

const DRIVER = "oid-driver-1";
const meta = { granularityMm: 1.0, deviceId: "device-1", appVersion: "0.0.0", totalPositions: 1 };

beforeEach(async () => {
  await db.open();
  await clearDraft();
  await db.table("outbox").clear();
  setDevActorId(DRIVER);
});

afterEach(() => {
  clearDevActorId();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  window.localStorage.clear();
});

async function queueOne() {
  await startDraft({
    driverSubject: DRIVER,
    vehicleId: "v1",
    taskId: null,
    startedAt: "2026-11-03T06:12:00Z",
    fleetNumber: null,
  });
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
  return queueDraft({ ...meta, submittedAt: "2026-11-03T06:14:40Z" });
}

const sent = () => ({ ok: true, status: 201, json: () => Promise.resolve({}) });

// Settles or not within a real wait far longer than the bound, so a red run
// fails on its assertion instead of hanging to the test timeout.
async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  const done = await Promise.race([work.then(() => true), late]);
  clearTimeout(timer);
  return done;
}

describe("a stalled send (TYRE-389)", () => {
  it("holds an entry whose response never finishes, and sends it on the next flush", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => new Promise(() => undefined) })
      .mockResolvedValueOnce(sent());
    vi.stubGlobal("fetch", fetchMock);
    const entry = await queueOne();

    expect(await settlesWithin(flushOutbox(), 2000)).toBe(true);

    const [held] = await listOutbox();
    expect(held.clientUuid).toBe(entry.clientUuid);
    expect(held.state).toBe("queued");
    expect(held.attempts).toBe(1);
    expect(held.lastStatus).toBeNull();

    await flushOutbox({ ignoreBackoff: true });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await listOutbox()).toEqual([]);
  });
});

// TYRE-385: a credential that failed is not asked for again in the same
// flush, since each ask can be a bounded renewal.
describe("one renewal per flush (TYRE-385)", () => {
  beforeEach(() => {
    clearDevActorId();
    bearerSession();
    plantSession({ accessToken: "at-old", subject: DRIVER, expiresInSeconds: -1 });
    window.localStorage.setItem(SUBJECT_KEY, DRIVER);
  });

  it("tries one renewal for three due entries when it fails, and holds all three", async () => {
    vi.mocked(renew).mockRejectedValue(new TypeError("Failed to fetch"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await queueOne();
    await queueOne();
    await queueOne();

    await flushOutbox();

    expect(renew).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const held = await listOutbox();
    expect(held).toHaveLength(3);
    expect(held.map((e) => [e.state, e.attempts])).toEqual([
      ["queued", 1],
      ["queued", 1],
      ["queued", 1],
    ]);
  });

  // The Remove dialog promises "nothing will be sent", and a forced send can
  // wait up to the bound on its renewal while Remove is still offered.
  it("does not post an entry the driver removed while its renewal ran", async () => {
    let finish!: (tokens: { accessToken: string; expiresAt: number; subject: string }) => void;
    vi.mocked(renew).mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const entry = await queueOne();
    await db.table("outbox").update(entry.clientUuid, { state: "failed", lastStatus: 409 });

    const sending = attemptSend(entry.clientUuid, { force: true });
    await vi.waitFor(() => expect(renew).toHaveBeenCalled());
    await discardEntry(entry.clientUuid);
    finish({ accessToken: "at-new", expiresAt: Date.now() + 3_600_000, subject: DRIVER });
    await sending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await listOutbox()).toEqual([]);
  });

  it("marks every due entry signed out from one lapsed renewal", async () => {
    vi.mocked(renew).mockResolvedValue(null);
    vi.stubGlobal("fetch", vi.fn());
    await queueOne();
    await queueOne();
    await queueOne();

    await flushOutbox();

    expect(renew).toHaveBeenCalledTimes(1);
    expect((await listOutbox()).map((e) => e.lastStatus)).toEqual([401, 401, 401]);
  });
});
