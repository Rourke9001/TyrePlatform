import { screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { FleetSettingsBody } from "../api/settings";
import type { Money } from "../api/money";
import { renderWithActor, requestedUrl, respond } from "../test/fixtures";
import { FleetSettings } from "./FleetSettings";

// A tenant with nothing configured, the shape settings.go answers for one.
function bare(): FleetSettingsBody {
  return {
    fleet: {
      timezone: "Africa/Johannesburg",
      currency: "ZAR",
      pressureUnit: "KPA",
      distanceUnit: "KM",
      historyHorizon: null,
    },
    thresholds: [],
    consent: [],
    priceList: [],
    catalogue: { sizes: [], brands: [], patterns: [] },
    moneyVisible: true,
  };
}

function stub(body: FleetSettingsBody) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      requestedUrl(input) === "/api/fleet-settings"
        ? Promise.resolve(respond(200, body))
        : Promise.resolve(respond(404, { code: "not_found", message: "no" })),
    ),
  );
}

function renderScreen() {
  return renderWithActor(<FleetSettings />, { capabilities: ["ManageConfig", "ViewValuation"] });
}

async function section(name: string): Promise<HTMLElement> {
  return screen.findByRole("region", { name });
}

function rowWith(region: HTMLElement, text: string): HTMLElement {
  const row = within(region).getByText(text).closest("tr");
  if (row === null) throw new Error(`no row holds ${text}`);
  return row;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fleet settings", () => {
  it("shows the fleet's timezone, currency, units and horizon", async () => {
    stub({ ...bare(), fleet: { ...bare().fleet, historyHorizon: "2026-10-01" } });
    renderScreen();
    const fleet = await section("Fleet");
    expect(fleet).toHaveTextContent("Africa/Johannesburg");
    expect(fleet).toHaveTextContent("ZAR (R)");
    expect(fleet).toHaveTextContent("kPa");
    expect(fleet).toHaveTextContent("km");
    expect(fleet).toHaveTextContent("Live capture from 01 Oct 2026");
  });

  it("shows each threshold in force with its scope", async () => {
    stub({
      ...bare(),
      thresholds: [
        {
          operatingGroupName: null,
          axleClass: null,
          removalThresholdMm: 4,
          warningThresholdMm: 6,
          maxRetreads: 2,
          retreadsPermitted: true,
          effectiveFrom: null,
        },
        {
          operatingGroupName: "North",
          axleClass: null,
          removalThresholdMm: 4.5,
          warningThresholdMm: 6.5,
          maxRetreads: 1,
          retreadsPermitted: true,
          effectiveFrom: "2026-10-20T08:00:00Z",
        },
        {
          operatingGroupName: null,
          axleClass: "STEER",
          removalThresholdMm: 5,
          warningThresholdMm: null,
          maxRetreads: 0,
          retreadsPermitted: false,
          effectiveFrom: "2026-10-20T08:00:00Z",
        },
      ],
    });
    renderScreen();
    const thresholds = await section("Tread thresholds");
    // WCAG 2.1.1: a keyboard reaches the table's hidden columns on a phone.
    expect(
      within(thresholds).getByRole("region", { name: "Tread thresholds table" }),
    ).toHaveAttribute("tabindex", "0");
    const fleetWide = rowWith(thresholds, "Whole fleet");
    expect(fleetWide).toHaveTextContent("4.0 mm");
    expect(fleetWide).toHaveTextContent("6.0 mm");
    expect(fleetWide).toHaveTextContent("2 allowed");
    expect(fleetWide).toHaveTextContent("From the start");
    expect(rowWith(thresholds, "Operating group: North")).toHaveTextContent("4.5 mm");
    const steer = rowWith(thresholds, "Axle class: Steer");
    expect(steer).toHaveTextContent("Not set");
    expect(steer).toHaveTextContent("Not permitted");
    expect(steer).toHaveTextContent("20 Oct 2026");
  });

  // An empty ledger is not consent: a purpose never recorded says so.
  it("shows every consent purpose, recorded or not", async () => {
    stub({
      ...bare(),
      consent: [
        {
          purpose: "ANONYMISED_BENCHMARKING",
          granted: false,
          noticeVersion: "MSA v2",
          givenAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
    renderScreen();
    const consent = await section("Consent");
    expect(rowWith(consent, "Service delivery")).toHaveTextContent("Not recorded");
    const benchmarking = rowWith(consent, "Anonymised benchmarking");
    expect(benchmarking).toHaveTextContent("Withdrawn");
    expect(benchmarking).toHaveTextContent("MSA v2");
    expect(benchmarking).toHaveTextContent("01 Oct 2026");
  });

  it("shows a recorded purpose the vocabulary does not know", async () => {
    stub({
      ...bare(),
      consent: [
        {
          purpose: "MARKETING",
          granted: true,
          noticeVersion: "MSA v3",
          givenAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
    renderScreen();
    const consent = await section("Consent");
    expect(rowWith(consent, "MARKETING")).toHaveTextContent("Granted");
    expect(rowWith(consent, "Service delivery")).toHaveTextContent("Not recorded");
  });

  it("shows the price list in force", async () => {
    stub({
      ...bare(),
      priceList: [
        {
          sizeName: "315/80R22.5",
          brandName: null,
          typicalPrice: "3500.00" as Money,
          effectiveFrom: "2026-09-01",
        },
        {
          sizeName: "315/80R22.5",
          brandName: "Dunlop",
          typicalPrice: "4319.91" as Money,
          effectiveFrom: "2026-06-01",
        },
      ],
    });
    renderScreen();
    const prices = await section("Price list");
    const anyBrand = rowWith(prices, "Any brand");
    expect(anyBrand).toHaveTextContent("R3,500.00");
    const dunlop = rowWith(prices, "Dunlop");
    expect(dunlop).toHaveTextContent("R4,319.91");
    expect(dunlop).toHaveTextContent("01 Jun 2026");
  });

  it("marks each catalogue entry's lineage", async () => {
    stub({
      ...bare(),
      catalogue: {
        sizes: [
          { id: "s1", name: "315/80R22.5", platformCatalogueId: "ps1" },
          { id: "s2", name: "T283 OWN", platformCatalogueId: null },
        ],
        brands: [{ id: "b1", name: "Dunlop", platformCatalogueId: "pb1" }],
        patterns: [
          { id: "p1", name: "SP431", brandId: "b1", appliesTo: "NEW", platformCatalogueId: null },
        ],
      },
    });
    renderScreen();
    const catalogue = await section("Catalogue");
    expect(rowWith(catalogue, "315/80R22.5")).toHaveTextContent("Platform catalogue");
    expect(rowWith(catalogue, "T283 OWN")).toHaveTextContent("Added for this fleet");
    expect(rowWith(catalogue, "Dunlop")).toHaveTextContent("Platform catalogue");
    expect(rowWith(catalogue, "SP431")).toHaveTextContent("Added for this fleet");
  });

  // Review focus 4: a section with nothing in it says so.
  it("empty sections say so", async () => {
    stub(bare());
    renderScreen();
    expect(await section("Fleet")).toHaveTextContent("No imported history");
    expect(await section("Tread thresholds")).toHaveTextContent(
      "No tread thresholds are in force.",
    );
    expect(await section("Price list")).toHaveTextContent("No price list entries are in force.");
    expect(await section("Catalogue")).toHaveTextContent("This fleet has no catalogue yet.");
    const consent = await section("Consent");
    expect(rowWith(consent, "Service delivery")).toHaveTextContent("Not recorded");
    expect(rowWith(consent, "Anonymised benchmarking")).toHaveTextContent("Not recorded");
  });

  it("explains a failed load rather than an empty page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(respond(500, { code: "internal", message: "no" }))),
    );
    renderScreen();
    expect(await screen.findByRole("alert")).toHaveTextContent(/settings didn.t load/i);
  });
});
