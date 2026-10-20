import { groupThousands } from "./groupThousands";

// FR-TYR-017: words for a measurement's age, a count of the tenant's
// calendar days the server sends (app.tenant_days_since, rule 6), so no
// browser clock decides it. A count below zero is still today's.
export function formatTreadAge(days: number): string {
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  return `${groupThousands(String(days))} days ago`;
}
