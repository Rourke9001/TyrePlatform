import type { TyreCatalogue } from "./catalogue";
import { apiGet } from "./client";
import type { Money } from "./money";

// Wire shape of GET /api/fleet-settings (api/internal/httpapi/settings.go,
// TYRE-283): what the tech team set at onboarding, shown and never edited.

export interface FleetSettingsFleet {
  timezone: string;
  currency: string;
  pressureUnit: string;
  distanceUnit: string;
  // FR-TEN-021: the date live capture starts, null for a fleet with no
  // imported history.
  historyHorizon: string | null;
}

// effectiveFrom is null for a scope's baseline, in force from the start.
export interface ThresholdInForce {
  operatingGroupName: string | null;
  axleClass: string | null;
  removalThresholdMm: number;
  warningThresholdMm: number | null;
  maxRetreads: number;
  retreadsPermitted: boolean;
  effectiveFrom: string | null;
}

export interface ConsentCurrent {
  purpose: string;
  granted: boolean;
  noticeVersion: string;
  givenAt: string;
}

// typicalPrice is null when money is hidden; moneyVisible says which.
export interface PriceInForce {
  sizeName: string;
  brandName: string | null;
  typicalPrice: Money | null;
  effectiveFrom: string;
}

export interface FleetSettingsBody {
  fleet: FleetSettingsFleet;
  thresholds: ThresholdInForce[];
  consent: ConsentCurrent[];
  priceList: PriceInForce[];
  catalogue: TyreCatalogue;
  moneyVisible: boolean;
}

export function fetchFleetSettings(): Promise<FleetSettingsBody> {
  return apiGet<FleetSettingsBody>("/api/fleet-settings");
}
