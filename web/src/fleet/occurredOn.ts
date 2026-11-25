import { ApiError } from "../api/apiError";

// The form's half of the day rule (FR-FIT-016 as amended, U253). It shows
// the reason field before the database would refuse its absence; the
// database places the day and decides (000067). Days are YYYY-MM-DD, so
// text order is day order.

export const WHY_REQUIRED = "Say why this movement is recorded for an earlier day.";

export function isEarlierDay(day: string, today: string): boolean {
  return day !== "" && day < today;
}

// What a movement adds to its body: the day whenever one is filled, a later
// one included, so the database refuses it in words rather than the form
// recording today (TYRE-240 spec, section 1). Null holds back an earlier day
// with no reason. `why` is renamed to the form's wire name by its caller.
export function occurredOnBody(
  day: string,
  why: string,
  today: string,
): { occurredOn?: string; why?: string } | null {
  const reason = why.trim();
  if (isEarlierDay(day, today) && reason === "") return null;
  if (day === "") return {};
  return reason === "" ? { occurredOn: day } : { occurredOn: day, why: reason };
}

// The database's words when an earlier day comes with no reason
// (app.backdate_reason_ok, 000067; pinned by suite 83a and
// TestMovementsRefuseAnEarlierDayWithNoReason). TY014 carries other
// refusals too, so the code alone cannot say a reason is wanted.
const LATE_WITHOUT_WHY = "a movement recorded for an earlier day records why";

// The reason field also opens after that refusal while a day is filled: a
// browser clock behind the server's reads the server's yesterday as today,
// and the refusal would otherwise leave nothing to fill (TYRE-240 spec,
// section 1).
export function askWhy(day: string, today: string, error: unknown): boolean {
  return (
    isEarlierDay(day, today) ||
    (day !== "" &&
      error instanceof ApiError &&
      error.code === "TY014" &&
      error.message === LATE_WITHOUT_WHY)
  );
}
