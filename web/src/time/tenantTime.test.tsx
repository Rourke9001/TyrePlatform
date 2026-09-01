import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { ActorContext } from "../auth/actorContext";
import type { Me } from "../auth/me";
import {
  formatTenantDate,
  INVALID_INSTANT,
  tenantDateFormatter,
  useTenantDate,
} from "./tenantTime";

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

  // A calendar date (Postgres `date`, serialised bare — no time component)
  // has no instant to project through a zone: the tenant's clerk wrote "5
  // January", and 5 January is what every viewer must read back. Pinned
  // against Pacific/Midway (UTC-11) because that is the zone where the old
  // instant-formatter behaviour (new Date("2026-01-05") parses as UTC
  // midnight, then re-projects west) visibly loses a day; the pilot tenant's
  // +02:00 zone rolls forward instead of back and hid this bug entirely.
  it("formats a bare YYYY-MM-DD date in the date itself, not the instant UTC midnight becomes in the zone", () => {
    expect(formatTenantDate("2026-01-05", "Pacific/Midway")).toBe("05 Jan 2026");
  });

  // The pilot tenant's own zone (+02:00) rolls a UTC-midnight instant
  // forward rather than back, so it read correctly even under the old
  // instant-projecting behaviour. Pin it too, so the date-only branch is
  // proven right for both directions, not just the one that used to fail.
  it("keeps the pilot tenant's zone correct for a calendar date", () => {
    expect(formatTenantDate("2026-01-05", "Africa/Johannesburg")).toBe("05 Jan 2026");
  });

  // The date-only branch is gated on a strict YYYY-MM-DD regex; a full ISO
  // instant must still take the zone-projecting path, which is the one this
  // module exists for (rule 6) and the case above already pins in both
  // directions. This is the same assertion restated with the module's
  // top-level `instant` fixture, so a regex broad enough to swallow instants
  // fails here even if it happened to agree with the case above by luck.
  it("still projects a full ISO instant through the tenant zone, not the date-only path", () => {
    expect(formatTenantDate(instant, "Africa/Johannesburg")).toBe("02 Jan 2026");
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

  // The date-only branch's regex shapes the string (four digits, two, two)
  // but does not validate calendar semantics — "2026-13-01" matches it and
  // is not a real date. Same failure mode as the instant branch above, same
  // fix: the marker, not a thrown RangeError.
  it("returns the marker rather than throwing on a regex-shaped but invalid calendar date", () => {
    expect(formatTenantDate("2026-13-01", "Africa/Johannesburg")).toBe(INVALID_INSTANT);
  });
});

// The cache is keyed per zone. Reusing one instance is the optimisation;
// the assertion that matters is the second one — a wrong key would render
// every tenant in the first tenant's zone (rule 6), a far worse defect than
// the construction cost the cache removes.
describe("tenantDateFormatter", () => {
  const instant = "2026-01-01T23:00:00Z";

  it("returns the same instance for the same zone", () => {
    expect(tenantDateFormatter("Pacific/Kiritimati")).toBe(
      tenantDateFormatter("Pacific/Kiritimati"),
    );
  });

  it("gives a different zone its own formatter, formatting in that zone", () => {
    const kiritimati = tenantDateFormatter("Pacific/Kiritimati");
    const midway = tenantDateFormatter("Pacific/Midway");
    expect(midway).not.toBe(kiritimati);
    // The two zones are 25 hours apart, so their civil dates can never agree.
    expect(formatTenantDate(instant, "Pacific/Kiritimati")).toBe("02 Jan 2026");
    expect(formatTenantDate(instant, "Pacific/Midway")).toBe("01 Jan 2026");
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
    displayCodePolicy: "FREE",
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

  // The identity matters, not just the output: a child that takes the
  // formatter as a prop can only memoise on it if re-renders with the same
  // actor state hand back the same function.
  it("returns the same callback across re-renders with the same actor", () => {
    const { result, rerender } = renderHook(() => useTenantDate(), {
      wrapper: withActor(me, true),
    });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
