import { type Page } from "@playwright/test";

import { actAs } from "./admin";

// BAC Transport's seeded actors (db/seeds/gen_seed_fixture.py), read-only
// from every spec but capture.spec.ts: BAC's rows are the Appendix E/J
// acceptance fixture (TYRE-80, TYRE-208 F5).
export const TENANT_BAC = "11111111-1111-1111-1111-111111111111";
export const NOMSA_CONTROLLER = "14fc2c61-398c-3508-084e-d61e615e695e";
export const PIETER_ORG_ADMIN = "e00cf25a-d426-83b3-df67-8c61f42c6bda";
export const MELUSI_DRIVER = "b85aef08-6081-80db-9d4d-dad38ae40545";

export function actAsPieter(page: Page): Promise<void> {
  return actAs(page, PIETER_ORG_ADMIN, TENANT_BAC);
}

export function actAsNomsa(page: Page): Promise<void> {
  return actAs(page, NOMSA_CONTROLLER, TENANT_BAC);
}

export function actAsMelusi(page: Page): Promise<void> {
  return actAs(page, MELUSI_DRIVER, TENANT_BAC);
}
