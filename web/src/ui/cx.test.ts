import { describe, expect, it } from "vitest";

import { cx } from "./cx";

describe("cx", () => {
  it("joins the names that apply and drops the rest", () => {
    expect(cx("tr-btn", false, "tr-btn--primary", null, undefined, "")).toBe(
      "tr-btn tr-btn--primary",
    );
    expect(cx()).toBe("");
  });
});
