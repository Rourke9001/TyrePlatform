import { useActor } from "../auth/actorContext";

// The only path a stored instant takes to a screen (rule 6, DR-010,
// FR-TEN-005). Storage is UTC throughout; what a person reads is their
// tenant's civil time, which is not the browser's — a South African fleet's
// truck inspected in America must still read as the South African day.
//
// en-ZA rather than the browser's locale: the tenant's calendar is the
// tenant's, and a date that reorders its parts per viewer is harder to read
// against a printed sheet, not easier.
export function formatTenantDate(instant: string | Date, timeZone: string): string {
  const at = typeof instant === "string" ? new Date(instant) : instant;
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(at);
}

// UTC is the fallback only while GET /api/me is in flight. Most screens are
// gated on the actor settling and never see it. /my is not — DriverHome
// renders before that race resolves — so on a reload or bookmark of it a
// date can briefly show in UTC instead of the tenant's zone until /api/me
// lands. A fallback that persists past that would be a bug in the screen,
// not here.
export function useTenantDate(): (instant: string | Date) => string {
  const timeZone = useActor()?.timezone ?? "UTC";
  return (instant) => formatTenantDate(instant, timeZone);
}
