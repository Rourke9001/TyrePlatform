import { describe, expect, it } from "vitest";

import {
  bandRangeLabel,
  basisLabel,
  formatCount,
  formatMm,
  formatPct,
  INFLATION_BAND_KEYS,
  inflationBandLabel,
  judgedAtLabel,
  severityLabel,
  treadSourceLabel,
  unavailableLabel,
} from "./vocabulary";

describe("severityLabel", () => {
  it("names the three severities and passes an unknown code through", () => {
    expect(severityLabel("CRITICAL")).toBe("Critical");
    expect(severityLabel("WARNING")).toBe("Warning");
    expect(severityLabel("INFO")).toBe("Info");
    expect(severityLabel("SEVERE")).toBe("SEVERE");
  });
});

// U18, U48: the page names the clock each figure is judged at, once.
describe("judgedAtLabel", () => {
  it("names the six clocks and passes an unknown code through", () => {
    expect(judgedAtLabel("SUBMITTED_AT")).toBe("as inspected");
    expect(judgedAtLabel("TODAY")).toBe("today");
    expect(judgedAtLabel("TENANT_TODAY")).toBe("on the tenant's calendar day");
    expect(judgedAtLabel("LATEST_READING")).toBe("at the latest reading");
    expect(judgedAtLabel("PERIOD")).toBe("for the period");
    expect(judgedAtLabel("AS_AT")).toBe("as at the chosen date");
    expect(judgedAtLabel("YESTERDAY")).toBe("YESTERDAY");
  });
});

// U32, U44: absence is a wire code with one wording, never inferred.
describe("unavailableLabel", () => {
  it("tells a depot-filtered reader to clear the filter and a depot actor that it is not there yet", () => {
    expect(unavailableLabel("TENANT_ONLY", true)).toBe(
      "Tenant-wide only. Clear the depot filter to see it.",
    );
    expect(unavailableLabel("TENANT_ONLY", false)).toBe("Not available for a depot view yet.");
    expect(unavailableLabel("NO_WINDOW", false)).toBe(
      "No compliance window is configured for this tenant.",
    );
    expect(unavailableLabel("NO_HORIZON", false)).toBe(
      "No forecast horizon is configured for this tenant.",
    );
    expect(unavailableLabel("SOMETHING_ELSE", false)).toBe("Not available (SOMETHING_ELSE).");
  });
});

// U29: AUDIT is the umbrella for "measured outside an inspection".
describe("treadSourceLabel and basisLabel", () => {
  it("say what each source is in words and pass an unknown code through", () => {
    expect(treadSourceLabel("READING")).toBe("inspection reading");
    expect(treadSourceLabel("AUDIT")).toBe("measured outside an inspection");
    expect(treadSourceLabel("GAUGE")).toBe("GAUGE");
    expect(basisLabel("ACTUAL")).toBe("actual cost");
    expect(basisLabel("ESTIMATED")).toBe("estimated");
    expect(basisLabel("AUDIT")).toBe("audit valuation");
    expect(basisLabel("OTHER")).toBe("OTHER");
  });
});

// U40: the band's words come from its bounds, never from bandLabel.
describe("bandRangeLabel", () => {
  it("reads a half-open band from its bounds and the last band as open", () => {
    expect(bandRangeLabel(0, 5)).toBe("0 to under 5 mm");
    expect(bandRangeLabel(11, 14)).toBe("11 to under 14 mm");
    expect(bandRangeLabel(14, null)).toBe("14 mm and over");
    expect(bandRangeLabel(4.5, 7.5)).toBe("4.5 to under 7.5 mm");
  });
});

describe("formatCount, formatMm and formatPct", () => {
  it("groups thousands, always shows one decimal of tread and none of a percentage", () => {
    // U55: a comma, as money groups.
    expect(formatCount(1234)).toBe("1,234");
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(0)).toBe("0");
    expect(formatMm(2)).toBe("2.0 mm");
    expect(formatMm(4)).toBe("4.0 mm");
    expect(formatMm(4.5)).toBe("4.5 mm");
    expect(formatPct(44.44)).toBe("44%");
    expect(formatPct(100)).toBe("100%");
  });
});

// TYRE-271: every identifier the API can send has words, and none of them
// is the identifier itself.
describe("inflationBandLabel", () => {
  it("names every band the database defines, in words", () => {
    expect(INFLATION_BAND_KEYS.map(inflationBandLabel)).toEqual([
      "Critically under target",
      "Under target",
      "Within target",
      "Over target",
      "Critically over target",
    ]);
    for (const key of INFLATION_BAND_KEYS) {
      expect(inflationBandLabel(key)).not.toMatch(/_/);
    }
  });

  it("passes an unknown identifier through", () => {
    expect(inflationBandLabel("flat")).toBe("flat");
  });
});
