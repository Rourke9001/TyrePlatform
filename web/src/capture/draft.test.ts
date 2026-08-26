import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { DraftPosition } from "./draft";
import { cellKey, clearDraft, db, loadDraft, saveHeader, savePosition, startDraft } from "./draft";

beforeEach(async () => {
  await db.open();
  await clearDraft();
});

afterEach(async () => {
  await clearDraft();
});

describe("the draft buffer", () => {
  it("generates the client uuid when the inspection starts, not when it is sent", async () => {
    const draft = await startDraft({
      vehicleId: "v1",
      taskId: "t1",
      startedAt: "2026-08-25T06:00:00Z",
    });
    expect(draft.clientUuid).toMatch(/^[0-9a-f-]{36}$/);
    // FR-OFF-011 keys idempotency on this. Generated at send time it would
    // change on every retry and each retry would create a new inspection.
    const reloaded = await loadDraft();
    expect(reloaded?.clientUuid).toBe(draft.clientUuid);
  });

  // FR-OFF-005: incrementally, per entry — not on a debounce, not at the end.
  it("persists a position the moment it is entered", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await savePosition({
      positionId: "p1",
      vehicleId: "v1",
      tyreId: "ty1",
      treads: [13, 13, 14],
      pressureKpa: 800,
      pressureTemperature: "UNKNOWN",
      damageFlag: false,
      note: null,
      seconds: 6,
      warnings: [],
    });

    const reloaded = await loadDraft();
    // Keyed by cell, because a position id names one wheel per member unit and
    // two units of the same configuration share the id (draft.cellKey).
    expect(reloaded?.positions[cellKey("v1", "p1")].treads).toEqual([13, 13, 14]);
    expect(reloaded?.positions[cellKey("v1", "p1")].seconds).toBe(6);
  });

  // FR-OFF-006 / NFR-USE-011. The store is the source of truth, not a mirror
  // of React state, so a reload finds the work rather than an empty form.
  it("survives a reload with every entry intact", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await savePosition({
      positionId: "p1",
      vehicleId: "v1",
      tyreId: null,
      treads: [9, 9, 10],
      pressureKpa: 750,
      pressureTemperature: "COLD",
      damageFlag: false,
      note: null,
      seconds: 5,
      warnings: [{ code: "FR-INS-037", response: "ACKNOWLEDGED", enteredValue: "750" }],
    });
    db.close();
    await db.open();

    const reloaded = await loadDraft();
    expect(reloaded?.positions[cellKey("v1", "p1")].pressureKpa).toBe(750);
    expect(reloaded?.positions[cellKey("v1", "p1")].warnings[0].code).toBe("FR-INS-037");
  });

  it("keeps the header fields the review screen collects", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await saveHeader({ odometerKm: 412500, comment: "7/8 need replacing", defectReport: null });

    const reloaded = await loadDraft();
    expect(reloaded?.odometerKm).toBe(412500);
    expect(reloaded?.comment).toBe("7/8 need replacing");
  });

  // The buffer holds ONE inspection (FR-OFF-007 withdrawn v1.4). Starting a
  // second must not silently bury the first — FR-OFF-014 forbids discarding a
  // buffered inspection under any circumstance, so the caller has to deal with
  // it rather than the store deciding.
  it("refuses to start a second inspection over an unfinished one", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await expect(
      startDraft({ vehicleId: "v2", taskId: null, startedAt: "2026-08-25T07:00:00Z" }),
    ).rejects.toThrow(/in progress/i);
  });

  // The one place the key FORMAT is stated rather than computed. Every other
  // fixture calls cellKey on both sides of its assertion, which holds for
  // whatever cellKey returns — a mutation back to the bare position id
  // included. This line is what makes those assertions mean something.
  it("keys a position by its unit AND its position", () => {
    expect(cellKey("v1", "p1")).toBe("v1:p1");
  });

  // The persisted draft is one JSON blob with nothing versioning its shape, so
  // a row written under a superseded key layout has to survive being read. A
  // reader that trusted the stored keys would show an untouched vehicle under a
  // header counting it done, and would send a re-entered wheel twice.
  it("reads a draft filed under superseded keys back by unit and position", async () => {
    const draft = await startDraft({
      vehicleId: "v1",
      taskId: null,
      startedAt: "2026-08-25T06:00:00Z",
    });
    const entry = (vehicleId: string, positionId: string, treads: number[]): DraftPosition => ({
      positionId,
      vehicleId,
      tyreId: null,
      treads,
      pressureKpa: 750,
      pressureTemperature: "UNKNOWN",
      damageFlag: false,
      note: null,
      seconds: 4,
      warnings: [],
    });

    // Written straight to the row, which is the only way to produce the layout:
    // savePosition cannot file under a bare id. Insertion order is the order a
    // driver would produce it — the unreachable entry first, the one entered
    // afterwards second.
    await db.drafts.put({
      key: "current",
      draft: {
        ...draft,
        positions: {
          p1: entry("v1", "p1", [9, 9, 9]),
          [cellKey("v1", "p1")]: entry("v1", "p1", [13, 13, 14]),
          // Two units of the same axle configuration share every position id, so
          // one bare "p1" names two different wheels. Both have to come back.
          [cellKey("v2", "p1")]: entry("v2", "p1", [11, 11, 12]),
        },
      },
    });

    const reloaded = await loadDraft();
    expect(Object.keys(reloaded?.positions ?? {}).sort()).toEqual([
      cellKey("v1", "p1"),
      cellKey("v2", "p1"),
    ]);
    // Last one wins, so the entry made after the unreachable one is the one
    // that survives — never the other way round.
    expect(reloaded?.positions[cellKey("v1", "p1")].treads).toEqual([13, 13, 14]);
    expect(reloaded?.positions[cellKey("v2", "p1")].treads).toEqual([11, 11, 12]);
  });

  it("reports no draft once cleared", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await clearDraft();
    expect(await loadDraft()).toBeUndefined();
  });

  // FR-OFF-002 / NFR-PRV-006: reference data (vehicle lists, tenant config,
  // thresholds) must never land on the device. This is the only IndexedDB
  // writer in the product, so it is the only place that rule can be broken,
  // and NFR-PRV-006 requires being able to tell a driver truthfully what is
  // stored. Asserting the exact key set — not a subset — is what catches a
  // field added to the persisted shape later without anyone deciding to.
  it("persists exactly the in-progress inspection and nothing else", async () => {
    await startDraft({ vehicleId: "v1", taskId: null, startedAt: "2026-08-25T06:00:00Z" });
    await savePosition({
      positionId: "p1",
      vehicleId: "v1",
      tyreId: null,
      treads: [9, 9, 10],
      pressureKpa: 750,
      pressureTemperature: "COLD",
      damageFlag: false,
      note: null,
      seconds: 5,
      warnings: [],
    });

    const row = await db.drafts.get("current");
    const keys = Object.keys(row?.draft ?? {}).sort();
    expect(keys).toEqual(
      [
        "clientUuid",
        "vehicleId",
        "combinationId",
        "observedMemberVehicleIds",
        "taskId",
        "startedAt",
        "odometerKm",
        "comment",
        "defectReport",
        "positions",
        "warnings",
      ].sort(),
    );
  });

  // FR-OFF-014's ban on ever burying an unfinished inspection only works if
  // the slot is actually freed once one is legitimately done with — otherwise
  // a driver's second inspection of the day is permanently blocked by the
  // "already in progress" guard above.
  it("frees the slot for a new inspection once cleared", async () => {
    const first = await startDraft({
      vehicleId: "v1",
      taskId: null,
      startedAt: "2026-08-25T06:00:00Z",
    });
    await clearDraft();
    const second = await startDraft({
      vehicleId: "v2",
      taskId: null,
      startedAt: "2026-08-25T09:00:00Z",
    });
    expect(second.clientUuid).not.toBe(first.clientUuid);
  });
});
