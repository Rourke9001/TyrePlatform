import { useCallback } from "react";

import { useActor, useActorSettled } from "../auth/actorContext";

// What an unparseable instant renders as: Intl.DateTimeFormat.format()
// throws RangeError on an invalid Date, and a throw here would blank the
// one screen a driver opens to start a capture (TYRE-95).
export const INVALID_INSTANT = "invalid date";

// The only path a stored instant takes to a screen (rule 6, DR-010,
// FR-TEN-005): storage is UTC, a person reads their tenant's civil time.
// en-ZA, not the browser's locale, since the tenant's calendar must not
// reorder per viewer.
export function formatTenantDate(instant: string | Date, timeZone: string): string {
  // A calendar date has no instant to project: new Date("2026-01-05") parses
  // as UTC midnight, and projecting that through a west-of-UTC zone shifts
  // the day, the mirror of the bug rule 6 exists to prevent. Formatted in
  // UTC instead.
  if (typeof instant === "string" && /^\d{4}-\d{2}-\d{2}$/.test(instant)) {
    const asUtcMidnight = new Date(`${instant}T00:00:00Z`);
    // The regex only shapes the string; "2026-13-01" matches it but is not a
    // real date. Same guard as the instant branch below, for the same
    // reason. .format() throws on an Invalid Date rather than returning one.
    if (Number.isNaN(asUtcMidnight.getTime())) {
      return INVALID_INSTANT;
    }
    return tenantDateFormatter("UTC").format(asUtcMidnight);
  }
  const at = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(at.getTime())) {
    return INVALID_INSTANT;
  }
  return tenantDateFormatter(timeZone).format(at);
}

// Constructing an Intl.DateTimeFormat costs roughly 10x a .format() call,
// and a list pays it per cell on the phone NFR-USE-001 judges. Keyed per
// zone, since a session sees at most a handful; a wrong key renders every
// tenant in the first tenant's zone (rule 6).
const formatters = new Map<string, Intl.DateTimeFormat>();

// Exported for the cache's identity tests only. Nothing renders through it:
// formatTenantDate carries the INVALID_INSTANT guard this does not, and it is
// the single path an instant takes to a screen (rule 6).
export function tenantDateFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-ZA", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

// UTC is the fallback while GET /api/me has not resolved (TYRE-95). In
// flight: render plainly, since the transient flash costs less than gating
// the landing screen. Errored: the fallback never lifts, so dates are
// marked provisional with the zone they were actually rendered in.
export function useTenantDate(): (instant: string | Date) => string {
  const actor = useActor();
  const settled = useActorSettled();
  const timeZone = actor?.timezone ?? "UTC";
  // Settled-with-no-actor means GET /api/me failed: fetchMe cannot succeed
  // with a null body, so this holds only as long as that stays true. An
  // "anonymous but successful" /api/me would need an explicit errored flag
  // in ActorState instead.
  const provisional = settled && actor === null;
  // Stable so a child that takes the formatter as a prop can memoise on it.
  return useCallback(
    (instant: string | Date) => {
      const text = formatTenantDate(instant, timeZone);
      // An unparseable instant is unparseable in every zone; a provisional
      // marker on it would imply the value could resolve once the actor does.
      return provisional && text !== INVALID_INSTANT ? `${text} (UTC)` : text;
    },
    [timeZone, provisional],
  );
}
