import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { ActorContext } from "../auth/actorContext";
import type { Me } from "../auth/me";
import { formatTenantDate, INVALID_INSTANT, useTenantDate } from "./tenantTime";

// A fixed instant in two zones 25 hours apart. Their civil dates can never
// agree, so this asserts the zone is honoured no matter where it runs — which
// is the whole point of the rule (rule 6, FR-TEN-005).
describe("formatTenantDate", () => {
  const instant = "2026-01-01T23:00:00Z";

  // Exact strings, not toContain: "2026" contains "02", so a substring
  // assertion on the day could never fail (docs/lessons.md, 20 Aug).
  it("renders the tenant's civil date, not the runner's", () => {
    expect(formatTenantDate(instant, "Pacific/Kiritimati")).toBe("02 Jan 2026");
    expect(formatTenantDate(instant, "Pacific/Midway")).toBe("01 Jan 2026");
  });

  it("puts a South African tenant on its own day for an instant captured abroad", () => {
    // 22:30 UTC is already the next day in Johannesburg (UTC+2).
    expect(formatTenantDate("2026-03-14T22:30:00Z", "Africa/Johannesburg")).toBe("15 Mar 2026");
    expect(formatTenantDate("2026-03-14T22:30:00Z", "America/Los_Angeles")).toBe("14 Mar 2026");
  });

  it("accepts a Date as readily as an ISO string", () => {
    expect(formatTenantDate(new Date(instant), "Pacific/Midway")).toEqual(
      formatTenantDate(instant, "Pacific/Midway"),
    );
  });

  // The server is the authority over the wire, and
  // Intl.DateTimeFormat.format() raises RangeError on an invalid Date. A
  // throw here unwinds DriverHome's map to a blank screen (TYRE-95), so a
  // bad instant must come back as a marker, never an exception.
  it("returns the marker rather than throwing on an unparseable instant", () => {
    expect(formatTenantDate("", "Africa/Johannesburg")).toBe(INVALID_INSTANT);
    expect(formatTenantDate("not-a-date", "Africa/Johannesburg")).toBe(INVALID_INSTANT);
    // The type says string, the wire may disagree; the cast is the test's
    // way of being the misbehaving server.
    expect(formatTenantDate(undefined as unknown as string, "Africa/Johannesburg")).toBe(
      INVALID_INSTANT,
    );
    expect(formatTenantDate(new Date("not-a-date"), "Africa/Johannesburg")).toBe(INVALID_INSTANT);
  });
});

describe("useTenantDate", () => {
  const instant = "2026-03-14T22:30:00Z";

  const me: Me = {
    userId: "u1",
    displayName: "Driver",
    role: "driver",
    capabilities: ["CaptureInspection"],
    depots: [],
    timezone: "Africa/Johannesburg",
  };

  function withActor(actor: Me | null, settled: boolean) {
    return function Wrapper({ children }: { children: ReactNode }) {
      return <ActorContext value={{ actor, settled }}>{children}</ActorContext>;
    };
  }

  it("renders the tenant's zone once the actor arrives", () => {
    const { result } = renderHook(() => useTenantDate(), { wrapper: withActor(me, true) });
    expect(result.current(instant)).toBe("15 Mar 2026");
  });

  // PR #37's accepted trade-off: the in-flight fallback renders plainly, so
  // the driver's landing screen is never gated on the /api/me round-trip.
  it("renders plainly in UTC while the actor request is still in flight", () => {
    const { result } = renderHook(() => useTenantDate(), { wrapper: withActor(null, false) });
    expect(result.current(instant)).toBe("14 Mar 2026");
  });

  // Staging 401s everyone until TYRE-2 (TYRE-95): when /api/me has failed
  // the UTC fallback never lifts, so the date must say it is provisional
  // rather than read a day out with full confidence.
  it("marks the date provisional once the actor request has errored", () => {
    const { result } = renderHook(() => useTenantDate(), { wrapper: withActor(null, true) });
    expect(result.current(instant)).toBe("14 Mar 2026 (UTC)");
  });

  it("never marks the invalid-instant marker provisional", () => {
    const { result } = renderHook(() => useTenantDate(), { wrapper: withActor(null, true) });
    expect(result.current("not-a-date")).toBe(INVALID_INSTANT);
  });
});
