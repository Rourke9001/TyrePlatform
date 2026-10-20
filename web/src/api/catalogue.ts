import { apiGet } from "./client";

// Wire shape of GET /api/tyre-catalogue (api/internal/httpapi/tyre_catalogue.go,
// TYRE-318): the tenant's active sizes, brands and patterns. A pattern no
// brand owns carries brandId null, and the receive form offers only NEW and
// BOTH patterns (FR-CFG-004). platformCatalogueId names the platform entry a
// row was seeded from, and is null for a row added for this fleet
// (FR-CFG-005).
export type PatternUse = "NEW" | "RETREAD" | "BOTH";

export interface TyreSize {
  id: string;
  name: string;
  platformCatalogueId: string | null;
}

export interface TyreBrand {
  id: string;
  name: string;
  platformCatalogueId: string | null;
}

export interface TyrePattern {
  id: string;
  name: string;
  brandId: string | null;
  appliesTo: PatternUse;
  platformCatalogueId: string | null;
}

export interface TyreCatalogue {
  sizes: TyreSize[];
  brands: TyreBrand[];
  patterns: TyrePattern[];
}

export function fetchTyreCatalogue(): Promise<TyreCatalogue> {
  return apiGet<TyreCatalogue>("/api/tyre-catalogue");
}
