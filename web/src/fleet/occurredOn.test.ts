import { describe, expect, it } from "vitest";

import { ApiError } from "../api/apiError";
import { askWhy, isEarlierDay, occurredOnBody } from "./occurredOn";

const today = "2026-11-25";

describe("occurredOnBody", () => {
  it("sends nothing for an empty day, whatever the reason says", () => {
    expect(occurredOnBody("", "", today)).toEqual({});
    expect(occurredOnBody("", " late ", today)).toEqual({});
  });

  it("sends a filled day, today included", () => {
    expect(occurredOnBody("2026-11-25", "", today)).toEqual({ occurredOn: "2026-11-25" });
    expect(occurredOnBody("2026-11-25", " late ", today)).toEqual({
      occurredOn: "2026-11-25",
      why: "late",
    });
  });

  it("holds back an earlier day with no reason, and trims one that has a reason", () => {
    expect(occurredOnBody("2026-11-20", "  ", today)).toBeNull();
    expect(occurredOnBody("2026-11-20", " job card ", today)).toEqual({
      occurredOn: "2026-11-20",
      why: "job card",
    });
  });

  // FR-FIT-016 as amended: the max attribute does not stop typing, so a
  // later day goes to the database, which refuses it in words.
  it("sends a typed future day for the database to refuse", () => {
    expect(occurredOnBody("2999-01-01", "", today)).toEqual({ occurredOn: "2999-01-01" });
  });
});

describe("isEarlierDay", () => {
  it("is a filled day before today", () => {
    expect(isEarlierDay("2026-11-24", today)).toBe(true);
    expect(isEarlierDay("2026-11-25", today)).toBe(false);
    expect(isEarlierDay("", today)).toBe(false);
  });
});

describe("askWhy", () => {
  const late = new ApiError(422, "a movement recorded for an earlier day records why", "TY014");

  it("asks for an earlier day, and after the database asks why while a day is filled", () => {
    expect(askWhy("2026-11-24", today, null)).toBe(true);
    expect(askWhy("2026-11-25", today, late)).toBe(true);
    expect(askWhy("2026-11-25", today, null)).toBe(false);
    expect(askWhy("", today, late)).toBe(false);
  });

  // TYRE-240 M2: TY014 is also a tread, position, reason code or future
  // day refusal, none of which a reason answers.
  it("does not ask after any other TY014", () => {
    const tread = new ApiError(
      422,
      "a fitment records its tread in millimetres, above 0 and at most 30",
      "TY014",
    );
    const future = new ApiError(
      422,
      "a movement is recorded on or before today, never on a future date",
      "TY014",
    );
    expect(askWhy("2026-11-25", today, tread)).toBe(false);
    expect(askWhy("2999-01-01", today, future)).toBe(false);
  });
});
