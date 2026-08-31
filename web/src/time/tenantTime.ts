import { useCallback } from "react";

import { useActor, useActorSettled } from "../auth/actorContext";

// What an unparseable instant renders as. /api/my/tasks is typed as
// returning ISO strings, but the server is the authority over the wire:
// Intl.DateTimeFormat.format() throws RangeError on an invalid Date, and a
// throw here unwinds the whole route — a blank screen on the one page a
// driver opens to start a capture, against the three-minute constraint
// (TYRE-95).
export const INVALID_INSTANT = "invalid date";

// The only path a stored instant takes to a screen (rule 6, DR-010,
// FR-TEN-005). Storage is UTC throughout; what a person reads is their
// tenant's civil time, which is not the browser's — a South African fleet's
// truck inspected in America must still read as the South African day.
//
// en-ZA rather than the browser's locale: the tenant's calendar is the
// tenant's, and a date that reorders its parts per viewer is harder to read
// against a printed sheet, not easier.
export function formatTenantDate(instant: string | Date, timeZone: string): string {
  const at = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(at.getTime())) {
    return INVALID_INSTANT;
  }
  return tenantDateFormatter(timeZone).format(at);
}

// Constructing an Intl.DateTimeFormat costs roughly ten times a .format()
// call on an existing instance, and a dashboard list or inspection history
// pays it per cell on the phone the three-minute constraint is judged on
// (NFR-USE-001). Keyed per zone because a session sees at most a handful —
// the tenant's and the UTC fallback — and a wrong key would render every
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

// UTC is the fallback while GET /api/me has not resolved, and the two ways
// of not resolving read differently (TYRE-95):
//
// - In flight: render plainly. PR #37 accepted the transient UTC flash on
//   /my deliberately — gating the driver's landing screen behind a
//   round-trip costs more than the flash, and screens behind
//   RequireCapability never reach a date pre-settle anyway.
// - Errored: the fallback never lifts, and every date would silently read a
//   day out for a Johannesburg tenant. Those dates are marked provisional
//   with the zone they were actually rendered in, so a reader is told the
//   tenant's day was not confirmed rather than shown certainty that is not
//   there.
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
