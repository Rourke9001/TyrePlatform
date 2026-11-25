import { describe, expect, it } from "vitest";

import {
  absenceLabel,
  bandRangeLabel,
  basisLabel,
  conditionLabel,
  costSourceLabel,
  distanceSourceLabel,
  INFLATION_BAND_KEYS,
  inflationBandLabel,
  inspectionMarkLabel,
  inspectionWarningLabel,
  judgedAtLabel,
  pressureBasisLabel,
  rateBasisLabel,
  removalReasonLabel,
  SEVERITY_CODES,
  severityLabel,
  subjectPositionLabel,
  treadSourceLabel,
  tyreStateLabel,
  unavailableLabel,
  warningResponseLabel,
} from "./vocabulary";

describe("severityLabel", () => {
  it("names the three severities and passes an unknown code through", () => {
    expect(severityLabel("CRITICAL")).toBe("Critical");
    expect(severityLabel("WARNING")).toBe("Warning");
    expect(severityLabel("INFO")).toBe("Info");
    expect(severityLabel("SEVERE")).toBe("SEVERE");
  });

  // The tiles and the exceptions filter list the severities in one order.
  it("lists the severities most urgent first, each in words", () => {
    expect(SEVERITY_CODES).toEqual(["CRITICAL", "WARNING", "INFO"]);
    expect(SEVERITY_CODES.map(severityLabel)).toEqual(["Critical", "Warning", "Info"]);
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

// CR-012: a distance never stands without its source, so an unknown one is
// passed through rather than dropped.
describe("distanceSourceLabel", () => {
  it("says where each distance came from and passes an unknown source through", () => {
    expect(distanceSourceLabel("MEASURED")).toBe("Measured");
    expect(distanceSourceLabel("INFERRED")).toBe("Inferred");
    expect(distanceSourceLabel("UNAVAILABLE")).toBe("Unavailable");
    expect(distanceSourceLabel("ESTIMATED")).toBe("ESTIMATED");
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

// U48, NFR-PRO-002: an absence the wire sends as null has one rendering,
// and none of them reads as a zero.
describe("absenceLabel", () => {
  it("names every absence the dashboard pages render", () => {
    expect(absenceLabel("unclassifiedShare")).toBe("none classified");
    expect(absenceLabel("unmeasured")).toBe("not measured");
    expect(absenceLabel("neverMeasured")).toBe("never");
    expect(absenceLabel("unknown")).toBe("unknown");
    expect(absenceLabel("undated")).toBe("not dated");
    expect(absenceLabel("noSpreadConfigured")).toBe(
      "No width spread is configured for this tenant.",
    );
    expect(absenceLabel("noTyres")).toBe("No tyres in this view");
    expect(absenceLabel("noTyresBody")).toBe(
      "Nothing is fitted or in stock here, so there is nothing to value.",
    );
    expect(absenceLabel("noneAtRisk")).toBe("None at risk");
    expect(absenceLabel("noSparesAtRisk")).toBe("No spares at or below the removal threshold");
    expect(absenceLabel("noTyresAtRisk")).toBe("Nothing at or below the removal threshold");
    expect(absenceLabel("noTyresAtRiskBody")).toBe(
      "Every fitted tyre in this view reads above the configured removal threshold.",
    );
    expect(absenceLabel("noReadingsInPeriod")).toBe("No readings in the period");
    expect(absenceLabel("noSpares")).toBe("No spares");
    expect(absenceLabel("noSparesBody")).toBe("No spare position carries a tyre in this view.");
    expect(absenceLabel("noOpenExceptions")).toBe("No open exceptions");
    expect(absenceLabel("noOpenExceptionsBody")).toBe(
      "Nothing the configured rules flag at the latest inspection of any unit in this view.",
    );
    expect(absenceLabel("unnamedDepot")).toBe("one depot");
  });
});

describe("basisLabel", () => {
  // U36: an unvalued casing reads in the Money rule's own words.
  it("names the register's UNVALUED basis the way the money column does", () => {
    expect(basisLabel("UNVALUED")).toBe("not valued");
  });
});

// U48: where an exception sits on its unit, from the wire's subject type
// and position codes.
describe("subjectPositionLabel", () => {
  it("names a whole unit, a pair, a position, a spare and an unknown place", () => {
    expect(subjectPositionLabel("VEHICLE", null, null, false)).toBe("whole unit");
    expect(subjectPositionLabel("POSITION_PAIR", "8", "7", false)).toBe("8 and 7");
    expect(subjectPositionLabel("TYRE", "7", null, false)).toBe("7");
    expect(subjectPositionLabel("TYRE", null, null, true)).toBe("spare");
    expect(subjectPositionLabel("TYRE", null, null, false)).toBe("unknown");
  });
});

// TYRE-325: a manager reads each warning the driver saw, in words, and none
// calls a tyre legal or roadworthy (CR-010).
describe("inspectionWarningLabel", () => {
  const written = [
    "FR-INS-031a",
    "FR-INS-033",
    "FR-INS-034",
    "FR-INS-035",
    "FR-INS-036",
    "FR-INS-037",
    "FR-INS-041",
    "FR-INS-063",
    "FR-OFF-016",
    "DR-020",
  ];

  it.each(written)("gives %s words of its own", (code) => {
    const words = inspectionWarningLabel(code);
    expect(words).not.toBe(code);
    expect(words).not.toContain(code);
    expect(words.toLowerCase()).not.toContain("legal");
    expect(words.toLowerCase()).not.toContain("roadworth");
  });

  it("shows a code it has no words for as another warning, with the code", () => {
    expect(inspectionWarningLabel("XYZ-1")).toBe("Other warning (XYZ-1)");
  });
});

describe("warningResponseLabel", () => {
  it("names the driver's response, and none for one the server raised", () => {
    expect(warningResponseLabel("CONFIRMED")).toBe("Confirmed");
    expect(warningResponseLabel("ACKNOWLEDGED")).toBe("Acknowledged");
    expect(warningResponseLabel(null)).toBe("None");
  });
});

describe("pressureBasisLabel", () => {
  it("names a pressure's basis (FR-INS-022a)", () => {
    expect(pressureBasisLabel("COLD")).toBe("cold");
    expect(pressureBasisLabel("HOT")).toBe("hot");
    expect(pressureBasisLabel("UNKNOWN")).toBe("basis unknown");
  });
});

describe("conditionLabel", () => {
  it("names each condition a tile can carry, saying what was judged", () => {
    expect(conditionLabel("limit")).toBe("Critical");
    expect(conditionLabel("near")).toBe("Warning");
    expect(conditionLabel("ok")).toBe("No exception");
    expect(conditionLabel("unread")).toBe("Not read");
    expect(conditionLabel("nospare")).toBe("No spare");
  });
});

describe("inspectionMarkLabel", () => {
  it("names the latest and a voided inspection", () => {
    expect(inspectionMarkLabel("latest")).toBe("Latest");
    expect(inspectionMarkLabel("voided")).toBe("Voided");
  });
});

describe("tyreStateLabel", () => {
  it("names the eight tyre states and passes an unknown one through", () => {
    expect(tyreStateLabel("IN_STOCK")).toBe("In stock");
    expect(tyreStateLabel("FITTED")).toBe("Fitted");
    expect(tyreStateLabel("REMOVED")).toBe("Removed");
    expect(tyreStateLabel("AT_RETREADER")).toBe("At retreader");
    expect(tyreStateLabel("AT_BREAKDOWN_SUPPLIER")).toBe("At breakdown supplier");
    expect(tyreStateLabel("SCRAPPED")).toBe("Scrapped");
    expect(tyreStateLabel("SOLD")).toBe("Sold");
    expect(tyreStateLabel("LOST")).toBe("Lost");
    expect(tyreStateLabel("MISLAID")).toBe("MISLAID");
  });
});

describe("costSourceLabel", () => {
  it("names what a stored figure rests on", () => {
    expect(costSourceLabel("INVOICE")).toBe("actual cost");
    expect(costSourceLabel("PRICE_LIST_ESTIMATE")).toBe("estimated");
    expect(costSourceLabel("UNKNOWN")).toBe("source not recorded");
  });
});

describe("rateBasisLabel", () => {
  it("names a re-rated casing's retread cost, and otherwise the cost source", () => {
    expect(rateBasisLabel("RETREAD_COST")).toBe("retread cost");
    expect(rateBasisLabel("INVOICE")).toBe("actual cost");
    expect(rateBasisLabel("PRICE_LIST_ESTIMATE")).toBe("estimated");
    expect(rateBasisLabel("UNKNOWN")).toBe("source not recorded");
    expect(rateBasisLabel("OTHER")).toBe("OTHER");
  });
});

describe("removalReasonLabel", () => {
  it("reads the tenant's words, and shows a code that has none", () => {
    expect(removalReasonLabel("damage", { damage: "Damage" })).toBe("Damage");
    expect(removalReasonLabel("puncture", {})).toBe("puncture");
  });
});
