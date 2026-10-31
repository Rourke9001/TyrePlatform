import { describe, expect, it } from "vitest";

import type { Money } from "../api/money";
import { dashboardBody, spareRow } from "../test/fixtures";
import { dashboardLede, heroView, panelsView, spareRows, tilesView } from "./dashboard.view";

// The view takes the tenant's formatters as arguments (rule 6); these mark
// what reached them, so a test reads which instant or date was formatted.
const instant = (at: string) => `I(${at})`;
const date = (at: string) => `D(${at})`;

const emptyClass = {
  tyreCount: 0,
  actualCount: 0,
  estimatedOrAuditCount: 0,
  auditCount: 0,
  unvaluedCount: 0,
  casingValueAtRisk: null,
};

describe("dashboardLede", () => {
  // U17, rule 6: one as-at instant with the tenant's zone named once.
  it("names the as-at instant and the zone", () => {
    expect(dashboardLede(dashboardBody(), "Africa/Johannesburg", instant)).toBe(
      "As at I(2026-09-22T07:10:45.563568Z), Africa/Johannesburg",
    );
  });

  it("leaves the zone out until the actor arrives", () => {
    expect(dashboardLede(dashboardBody(), undefined, instant)).toBe(
      "As at I(2026-09-22T07:10:45.563568Z)",
    );
  });

  // U42, U55: a depot-scoped reader is told how many depots, singular for one.
  it("counts a depot-scoped reader's depots", () => {
    const one = dashboardBody({ scope: { level: "DEPOTS", depotCount: 1, depot: null } });
    const three = dashboardBody({ scope: { level: "DEPOTS", depotCount: 3, depot: null } });
    expect(dashboardLede(one, "UTC", instant)).toMatch(/, UTC, across your 1 depot$/);
    expect(dashboardLede(three, "UTC", instant)).toMatch(/, UTC, across your 3 depots$/);
  });
});

describe("heroView", () => {
  // Rule 2: the figure is the wire string, handed on untouched for the
  // screen to format; U36 and U44 decide its absence from what travels with it.
  it("hands the running figure on as the wire string, with the set it sums", () => {
    const hero = heroView(dashboardBody());
    expect(hero.figure.value).toBe("16537.50");
    expect(hero.figure.visible).toBe(true);
    expect(hero.figure.set).toEqual({ tyreCount: 9, empty: "None at risk" });
    expect(hero.qualifier).toBe("from 9 running tyres at or below the removal threshold today");
    expect(hero.footnote).toBe(
      "0 at actual cost, 9 estimated or audit, of which 9 audit; 0 unvalued",
    );
    expect(hero.segments).toEqual([
      { key: "actual", label: "Actual", count: 0 },
      { key: "estimated", label: "Estimated or audit", count: 9 },
      { key: "unvalued", label: "Unvalued", count: 0 },
    ]);
  });

  // U18: the count behind the figure is the register's, not the class's.
  it("counts the running tyres from below-threshold", () => {
    const hero = heroView(
      dashboardBody({ belowThreshold: { judgedAt: "TODAY", running: 1, spare: 0 } }),
    );
    expect(hero.qualifier).toBe("from 1 running tyre at or below the removal threshold today");
  });

  it("words the spare line around its figure, with any unvalued count", () => {
    const base = dashboardBody().valueAtRisk;
    expect(heroView(dashboardBody()).spare).toEqual({
      before: "Spares: ",
      money: { value: "1837.50", visible: true },
      after: " from 1 tyre",
    });
    const hero = heroView(
      dashboardBody({
        valueAtRisk: { ...base, spare: { ...base.spare, tyreCount: 3, unvaluedCount: 2 } },
      }),
    );
    expect(hero.spare).toEqual({
      before: "Spares: ",
      money: { value: "1837.50", visible: true },
      after: " from 3 tyres, 2 unvalued",
    });
  });

  // U36, U44: an empty spare class is its absence, unless money is hidden.
  it("names an empty spare class, and Hidden still wins over it", () => {
    const valueAtRisk = { judgedAt: "TODAY", running: emptyClass, spare: emptyClass };
    expect(heroView(dashboardBody({ valueAtRisk })).spare).toEqual({
      text: "No spares at or below the removal threshold",
    });
    expect(heroView(dashboardBody({ valueAtRisk, moneyVisible: false })).spare).toEqual({
      before: "Spares: ",
      money: { value: null, visible: false },
      after: " from 0 tyres",
    });
  });

  // D7: /at-risk is gated on ViewValuation, so a reader without money is
  // offered no link to a refusal; a depot view's link keeps the depot (U17).
  it("links to the at-risk list only when money is visible", () => {
    expect(heroView(dashboardBody(), "d1").link).toEqual({
      to: "/at-risk?depot=d1",
      label: "See the at-risk list",
    });
    expect(heroView(dashboardBody({ moneyVisible: false })).link).toBeUndefined();
  });

  // The figure is coloured only when it is a sum at risk: Hidden and None
  // at risk are words, not a problem.
  it("marks the figure critical only for a valued sum at risk", () => {
    expect(heroView(dashboardBody()).tone).toBe("critical");
    expect(heroView(dashboardBody({ moneyVisible: false })).tone).toBe("default");
    const none = { judgedAt: "TODAY", running: emptyClass, spare: emptyClass };
    expect(heroView(dashboardBody({ valueAtRisk: none })).tone).toBe("default");
    const unvalued = { ...none, running: { ...emptyClass, tyreCount: 2, unvaluedCount: 2 } };
    expect(heroView(dashboardBody({ valueAtRisk: unvalued })).tone).toBe("default");
  });
});

describe("tilesView", () => {
  // FR-DSH-002, U27: tread and casing each carry their own split and count.
  it("gives tread and casing their own figure, unvalued count and split", () => {
    const { estate } = tilesView(dashboardBody());
    expect(estate.judged).toBe("today");
    expect(estate.tread.value).toEqual({
      value: "20571.00",
      visible: true,
      set: { tyreCount: 27, empty: "No tyres in this view" },
    });
    expect(estate.tread.unvalued).toBe("0 of 27 unvalued");
    expect(estate.tread.segments.map((s) => s.key)).toEqual(["actual", "estimated", "unvalued"]);
    expect(estate.casing.value.value).toBe("49612.50");
    expect(estate.casing.segments).toEqual([
      { key: "actual", label: "Actual", count: 0 },
      { key: "estimated", label: "Estimated", count: 0 },
      { key: "audit", label: "Audit", count: 27 },
      { key: "unvalued", label: "Unvalued", count: 0 },
    ]);
    expect(estate.total).toEqual({
      before: "",
      money: {
        value: "70183.50",
        visible: true,
        set: { tyreCount: 27, empty: "No tyres in this view" },
      },
      after: " across 27 tyres in total.",
    });
  });

  // U44, 000049: a partial total discloses both sides' unvalued counts.
  it("discloses a partial total's unvalued counts", () => {
    const base = dashboardBody().estate;
    const { estate } = tilesView(
      dashboardBody({ estate: { ...base, unvaluedCount: 3, casingUnvaluedCount: 6 } }),
    );
    expect(estate.total).toMatchObject({
      after: " across 27 tyres in total; tread 3 of 27 unvalued, casing 6 of 27 unvalued.",
    });
  });

  // U44: an empty estate's line is its absence alone; Hidden wins over it.
  it("names an empty estate, unless money is hidden", () => {
    const base = dashboardBody().estate;
    const empty = { ...base, tyreCount: 0, totalValue: null };
    expect(tilesView(dashboardBody({ estate: empty })).estate.total).toEqual({
      text: "No tyres in this view.",
    });
    expect(
      tilesView(dashboardBody({ estate: empty, moneyVisible: false })).estate.total,
    ).toMatchObject({ money: { value: null, visible: false }, after: " across 0 tyres in total." });
  });

  it("reads the open count, its severities in order and the clock", () => {
    const { exceptions } = tilesView(dashboardBody());
    expect(exceptions.value).toBe("19");
    expect(exceptions.tone).toBe("critical");
    expect(exceptions.detail).toBe("11 urgent; 9 rules configured");
    expect(exceptions.judged).toBe("as inspected");
    expect(exceptions.link).toEqual({ to: "/exceptions", label: "See the list" });
    expect(exceptions.severities).toEqual([
      { code: "CRITICAL", text: "Critical 11", to: "/exceptions?severity=CRITICAL" },
      { code: "WARNING", text: "Warning 8", to: "/exceptions?severity=WARNING" },
    ]);
  });

  // A code the vocabulary does not know is still listed, after the known
  // ones, in its own spelling.
  it("lists an unknown severity after the known ones", () => {
    const base = dashboardBody().exceptions;
    const { exceptions } = tilesView(
      dashboardBody({ exceptions: { ...base, bySeverity: { NOTICE: 2, INFO: 1, CRITICAL: 3 } } }),
    );
    expect(exceptions.severities.map((s) => s.text)).toEqual(["Critical 3", "Info 1", "NOTICE 2"]);
  });

  // U17: every list link off a depot view carries the depot.
  it("carries the depot onto every list link", () => {
    const { exceptions, below } = tilesView(dashboardBody(), "d1");
    expect(exceptions.link.to).toBe("/exceptions?depot=d1");
    expect(exceptions.severities[0].to).toBe("/exceptions?severity=CRITICAL&depot=d1");
    expect(below.link?.to).toBe("/at-risk?depot=d1");
  });

  it("reads the threshold count today, linked only when money is visible", () => {
    const { below } = tilesView(dashboardBody());
    expect(below.value).toBe("9");
    expect(below.tone).toBe("critical");
    expect(below.detail).toBe("running positions; 1 spare disclosed separately");
    expect(below.judged).toBe("today");
    expect(below.link).toEqual({ to: "/at-risk", label: "See the at-risk list" });
    expect(tilesView(dashboardBody({ moneyVisible: false })).below.link).toBeUndefined();
    const quiet = tilesView(
      dashboardBody({ belowThreshold: { judgedAt: "TODAY", running: 0, spare: 0 } }),
    );
    expect(quiet.below.tone).toBe("default");
  });

  // FR-DSH-005, 006; FR-EXC-027, 029: each tile reads its own field.
  it("gives each unit tile its own field and the panel its clock", () => {
    const { units } = tilesView(
      dashboardBody({
        units: {
          judgedAt: "TENANT_TODAY",
          total: 7,
          scheduled: 4,
          covered: 3,
          unscheduled: 3,
          stale: 2,
          staleUnknown: 1,
        },
        overdueTasks: 5,
        pendingCompositionReports: 6,
      }),
    );
    expect(units.judged).toBe("on the tenant's calendar day");
    expect(units.coverage).toEqual({ value: "3 of 7", detail: "4 scheduled, 3 unscheduled" });
    expect(units.overdue).toEqual({ value: "5", tone: "warning" });
    expect(units.stale).toEqual({
      value: "2",
      detail: "1 unknown, never inspected",
      tone: "warning",
    });
    expect(units.rigs).toEqual({
      value: "6",
      tone: "warning",
      link: { to: "/fleet/rigs", label: "See the rigs" },
    });
  });

  // U17: /fleet/rigs cannot narrow to a depot, so a depot view has no link.
  it("offers the rigs link only when no depot is chosen", () => {
    expect(tilesView(dashboardBody(), "d1").units.rigs.link).toBeUndefined();
    const quiet = tilesView(dashboardBody()).units;
    expect(quiet.stale.detail).toBeUndefined();
    expect(quiet.overdue.tone).toBe("default");
  });
});

describe("panelsView", () => {
  // U52, rule 6: the server's two dates, through the tenant's calendar.
  it("names the configured window, or a chosen period by its dates", () => {
    expect(panelsView(dashboardBody(), undefined, false, date).inflation).toMatchObject({
      judged: "for the period",
      window:
        "Configured window: 30 days, D(2026-08-24) to D(2026-09-23). The end date is excluded.",
    });
    const base = dashboardBody().inflationCompliance;
    const chosen = dashboardBody({
      inflationCompliance: { ...base, from: "2026-07-01", to: "2026-08-01", windowDays: null },
    });
    expect(panelsView(chosen, undefined, false, date).inflation.window).toBe(
      "Chosen period: D(2026-07-01) to D(2026-08-01). The end date is excluded.",
    );
  });

  // U32, U44: TENANT_ONLY has two wordings, by who asked.
  it("words an unavailable panel by whether the reader filtered", () => {
    const body = dashboardBody({
      inflationCompliance: {
        from: null,
        to: null,
        windowDays: null,
        unavailable: "TENANT_ONLY",
        bands: [],
      },
    });
    expect(panelsView(body, "d1", true, date).inflation).toMatchObject({
      unavailable: "Tenant-wide only. Clear the depot filter to see it.",
      window: undefined,
    });
    expect(panelsView(body, undefined, false, date).inflation.unavailable).toBe(
      "Not available for a depot view yet.",
    );
  });

  // U86, TYRE-271: each band named in words, each column its own field,
  // and a null share named rather than 0%.
  it("words each inflation band and names a null share", () => {
    const base = dashboardBody().inflationCompliance;
    const { rows } = panelsView(
      dashboardBody({
        inflationCompliance: {
          ...base,
          bands: [
            {
              ...base.bands[0],
              readingCount: 4000,
              tyreCount: 12,
              pctOfClassified: 62.5,
              coldCount: 25,
              hotCount: 9,
              unknownCount: 6,
            },
            base.bands[1],
          ],
        },
      }),
      undefined,
      false,
      date,
    ).inflation;
    expect(rows).toEqual([
      {
        key: "1",
        band: "Critically under target",
        readings: "4,000",
        tyres: "12",
        share: "63%",
        cold: "25",
        hot: "9",
        unknown: "6",
      },
      {
        key: "2",
        band: "Under target",
        readings: "0",
        tyres: "0",
        share: "none classified",
        cold: "0",
        hot: "0",
        unknown: "0",
      },
    ]);
  });

  // FR-DSH-008, U40: the bands are labelled from their bounds, never from
  // bandLabel, and the wire's share passes through for the chart to round.
  it("labels the tread bands from their bounds", () => {
    const { tread } = panelsView(dashboardBody(), undefined, false, date);
    expect(tread.judged).toBe("today");
    const { bands } = tread;
    expect(bands.map((b) => b.label)).toEqual([
      "0 to under 5 mm",
      "5 to under 8 mm",
      "8 to under 11 mm",
      "11 to under 14 mm",
      "14 mm and over",
    ]);
    expect(bands[0]).toEqual({ label: "0 to under 5 mm", count: 10, pctOfGroup: 37.04 });
  });

  // FR-DSH-009; rule 5: a null horizon is a configuration absence.
  it("reads the forecast from its own fields, absences in words", () => {
    expect(panelsView(dashboardBody(), undefined, false, date).forecast).toEqual({
      value: "10",
      detail: "within 30 days of D(2026-09-22)",
      judged: "today",
    });
    const unset = dashboardBody({
      removalForecast: {
        horizonDays: null,
        from: "2026-09-22",
        unavailable: "NO_HORIZON",
        judgedAt: "TODAY",
        dueCount: null,
      },
    });
    expect(panelsView(unset, undefined, false, date).forecast).toEqual({
      value: "No forecast horizon is configured for this tenant.",
      detail: undefined,
      judged: "today",
    });
  });

  // dashboard.go sends a null count only with its reason; one without is a
  // server defect, named unknown.
  it("names a null forecast with no reason as unknown", () => {
    const base = dashboardBody().removalForecast;
    const body = dashboardBody({ removalForecast: { ...base, dueCount: null } });
    expect(panelsView(body, undefined, false, date).forecast.value).toBe("unknown");
  });

  // FR-DSH-016: the tile names FR-EXC-035, the rule its count answers to.
  it("reads irregular wear against the configured spread, linked to its rule", () => {
    expect(panelsView(dashboardBody(), "d1", false, date).wear).toEqual({
      value: "5",
      detail: "running positions with a spread of 4.0 mm or more; 1 spare disclosed separately",
      judged: "at the latest reading",
      link: { to: "/exceptions?rule=FR-EXC-035&depot=d1", label: "See the list" },
    });
    const unset = dashboardBody({
      irregularWear: { judgedAt: "LATEST_READING", spreadWarnMm: null, running: 0, spare: 0 },
    });
    expect(panelsView(unset, undefined, false, date).wear).toMatchObject({
      value: "No width spread is configured for this tenant.",
      detail: undefined,
    });
  });
});

describe("spareRows", () => {
  // FR-RPT-041, FR-TYR-017: the day a spare was measured with its age, on
  // the tenant's calendar; every null named, never 0.
  it("writes each spare's cells, absences named", () => {
    const rows = spareRows(
      [
        spareRow({ tyreId: "s1" }),
        spareRow({ tyreId: "s2", daysSinceMeasured: null }),
        spareRow({
          tyreId: "s3",
          currentTreadMm: null,
          measuredSource: null,
          lastMeasuredAt: null,
          daysSinceMeasured: null,
          ageDays: null,
        }),
      ],
      date,
    );
    expect(rows[0]).toEqual({
      key: "s1",
      code: "2102BACS",
      vehicleId: "v12",
      fleetNumber: "LINK12",
      position: "S",
      tread: "2.0 mm",
      source: "inspection reading",
      measured: "D(2026-07-23T05:46:30Z), 61 days ago",
      age: "935",
    });
    expect(rows[1].measured).toBe("D(2026-07-23T05:46:30Z)");
    expect(rows[2]).toMatchObject({
      tread: "not measured",
      source: "not measured",
      measured: "never",
      age: "unknown",
    });
  });
});

// Rule 2 at the seam: no figure the view hands on is a reformatted string.
describe("money through the view", () => {
  it("never rewrites a wire money string", () => {
    const odd = "1234567.5" as Money;
    const base = dashboardBody();
    const body = dashboardBody({
      valueAtRisk: {
        ...base.valueAtRisk,
        running: { ...base.valueAtRisk.running, casingValueAtRisk: odd },
      },
      estate: { ...base.estate, treadValue: odd },
    });
    expect(heroView(body).figure.value).toBe(odd);
    expect(tilesView(body).estate.tread.value.value).toBe(odd);
  });
});
