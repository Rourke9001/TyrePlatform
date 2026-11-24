import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchUnitCondition,
  fetchUnitInspection,
  fetchUnitInspections,
  voidInspection,
  type UnitInspectionPage,
} from "./inspections";
import {
  exceptionRow,
  inspectionDetail,
  requestedUrl,
  respond,
  sentBody,
  unitInspection,
} from "../test/fixtures";
import type { ExceptionRow } from "./dashboard";

function page(latestInspectionId: string | null, ...ids: string[]): UnitInspectionPage {
  return {
    inspections: ids.map((id) => unitInspection({ inspectionId: id })),
    nextAfter: null,
    latestInspectionId,
  };
}

function exceptions(...rows: ExceptionRow[]) {
  return { scope: { level: "TENANT", depotCount: 1, depot: null }, judgedAt: "SUBMITTED_AT", exceptions: rows };
}

// Answers each request by its path, counting how often each was asked, so a
// test can hand out a different answer to the second ask of the same path.
function serve(answers: Record<string, unknown[]>) {
  const asked: Record<string, number> = {};
  vi.mocked(fetch).mockImplementation((input) => {
    const url = requestedUrl(input);
    const n = asked[url] ?? 0;
    asked[url] = n + 1;
    const list = answers[url];
    if (list === undefined) return Promise.resolve(respond(404, { code: "not_found" }));
    return Promise.resolve(respond(200, list[Math.min(n, list.length - 1)]));
  });
  return asked;
}

describe("the inspection API module", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests a unit's inspections, and the page after a cursor", async () => {
    vi.mocked(fetch).mockImplementation(() => Promise.resolve(respond(200, page(null))));
    await fetchUnitInspections("u9");
    await fetchUnitInspections("u9", "i20");
    expect(requestedUrl(vi.mocked(fetch).mock.calls[0][0])).toBe("/api/vehicles/u9/inspections");
    expect(requestedUrl(vi.mocked(fetch).mock.calls[1][0])).toBe(
      "/api/vehicles/u9/inspections?after=i20",
    );
  });

  it("requests one inspection of a unit", async () => {
    vi.mocked(fetch).mockResolvedValue(respond(200, inspectionDetail()));
    await fetchUnitInspection("u9", "i1");
    expect(requestedUrl(vi.mocked(fetch).mock.calls[0][0])).toBe("/api/vehicles/u9/inspections/i1");
  });

  // Review Focus 1: the latest comes from latestInspectionId, never the page.
  it("reads the latest the list names, whatever its first row is, beside the unit's exceptions", async () => {
    const voided = page("i2", "i5");
    voided.inspections[0] = unitInspection({ inspectionId: "i5", state: "VOIDED" });
    const detail = inspectionDetail({ inspection: unitInspection({ inspectionId: "i2" }) });
    const row = exceptionRow({ subjectId: "t1", inspectionId: "i2" });
    const asked = serve({
      "/api/vehicles/u9/inspections": [voided],
      "/api/exceptions?vehicle=u9": [exceptions(row)],
      "/api/vehicles/u9/inspections/i2": [detail],
    });

    const condition = await fetchUnitCondition("u9");

    expect(condition.latest).toEqual(detail);
    expect(condition.exceptions).toEqual([row]);
    expect(asked["/api/vehicles/u9/inspections/i2"]).toBe(1);
  });

  it("fetches no detail when the unit has no latest inspection", async () => {
    const asked = serve({
      "/api/vehicles/u9/inspections": [page(null)],
      "/api/exceptions?vehicle=u9": [exceptions()],
    });

    const condition = await fetchUnitCondition("u9");

    expect(condition).toEqual({ latest: null, exceptions: [] });
    expect(Object.keys(asked).sort()).toEqual([
      "/api/exceptions?vehicle=u9",
      "/api/vehicles/u9/inspections",
    ]);
  });

  // Red team M1: a row on another inspection means a write landed between
  // the two reads. Read both again once, and never drop a row.
  it("reads both again when an exception row names another inspection, and keeps every row", async () => {
    const stale = exceptionRow({ subjectId: "t1", inspectionId: "i1" });
    const fresh = exceptionRow({ subjectId: "t2", inspectionId: "i2" });
    const asked = serve({
      "/api/vehicles/u9/inspections": [page("i2"), page("i2")],
      "/api/exceptions?vehicle=u9": [exceptions(stale, fresh), exceptions(fresh)],
      "/api/vehicles/u9/inspections/i2": [inspectionDetail()],
    });

    const condition = await fetchUnitCondition("u9");

    expect(asked["/api/vehicles/u9/inspections"]).toBe(2);
    expect(asked["/api/exceptions?vehicle=u9"]).toBe(2);
    expect(condition.exceptions).toEqual([fresh]);
  });

  it("fails rather than drop rows when the two reads disagree twice", async () => {
    serve({
      "/api/vehicles/u9/inspections": [page("i2")],
      "/api/exceptions?vehicle=u9": [
        exceptions(exceptionRow({ subjectId: "t1", inspectionId: "i1" })),
      ],
    });

    await expect(fetchUnitCondition("u9")).rejects.toThrow(
      "the unit's condition changed while it was read",
    );
  });

  it("counts a row while the unit has no latest inspection as a disagreement", async () => {
    const asked = serve({
      "/api/vehicles/u9/inspections": [page(null)],
      "/api/exceptions?vehicle=u9": [
        exceptions(exceptionRow({ subjectId: "t1", inspectionId: "i1" })),
      ],
    });

    await expect(fetchUnitCondition("u9")).rejects.toThrow(
      "the unit's condition changed while it was read",
    );
    expect(asked["/api/exceptions?vehicle=u9"]).toBe(2);
  });

  it("posts the void's reason to the inspection", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await voidInspection("i1", "wrong rig");

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(requestedUrl(url)).toBe("/api/inspections/i1/void");
    expect(init?.method).toBe("POST");
    expect(sentBody(0)).toEqual({ reason: "wrong rig" });
  });
});
