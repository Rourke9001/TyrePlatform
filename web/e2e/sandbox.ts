import { randomUUID } from "node:crypto";

import { expect, type APIResponse, type Page, type Response } from "@playwright/test";

// Sandbox Fleet fixture surface shared by fitments.spec.ts,
// observations.spec.ts, rigs.spec.ts, rotation.spec.ts and tasks.spec.ts.
// Specs never import each other (TYRE-80); this is where their common
// write-flow helpers live instead.

// Seed-derived ids, per admin.ts: md5('sbcontroller1') holds ViewFleet,
// ManageAssets and ManageAssignments, and md5('sbdriver1') is the Sandbox
// driver these flows assign, schedule and submit as.
export const TENANT = "33333333-3333-3333-3333-333333333333";
export const CONTROLLER = "c8b320df-8f90-ce76-e180-9d35ea293a9c";
export const SANDBOX_DRIVER = "40f019ce-192e-92d1-5b15-2eb7b65369df";

// The dev actor headers a raw request has to state itself (admin.ts).
export const ACTOR = { "X-Tenant-ID": TENANT, "X-User-ID": CONTROLLER };
export const DRIVER_ACTOR = { "X-Tenant-ID": TENANT, "X-User-ID": SANDBOX_DRIVER };

export function postedResponse(page: Page, path: RegExp): Promise<Response> {
  return page.waitForResponse(
    (res) => path.test(new URL(res.url()).pathname) && res.request().method() === "POST",
  );
}

// Without the res.ok() check a step chained under this promise could pass on
// a 422 refusal as readily as on a real write.
export function posted(page: Page, path: RegExp): Promise<Response> {
  return postedResponse(page, path).then((res) => {
    expect(res.ok()).toBeTruthy();
    return res;
  });
}

// For calls expected to be refused (future-dated dispatch, INV-2's
// still-fitted check): posted()'s res.ok() would fail before the refusal text
// is read, so asserting the refusal here catches an unexpected success too.
export function postedRefusal(page: Page, path: RegExp): Promise<Response> {
  return postedResponse(page, path).then((res) => {
    expect(res.ok()).toBeFalsy();
    return res;
  });
}

export async function apiGet(
  page: Page,
  path: string,
  headers: Record<string, string> = ACTOR,
): Promise<unknown> {
  const res = await page.request.get(path, { headers });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

export async function apiPost(page: Page, path: string, data: unknown): Promise<unknown> {
  const res = await page.request.post(path, { headers: ACTOR, data });
  expect(res.ok(), await res.text()).toBeTruthy();
  return res.json();
}

export interface AxleConfiguration {
  id: string;
  code: string;
}

export interface CaptureContext {
  positions: { id: string; isSpare: boolean }[];
  config: { treadReadingCount: number };
}

export interface Position {
  id: string;
  code: string;
  isSpare: boolean;
}

// A fleet's axle configurations are tenant data (FR-VEH-002), so the ids are
// read rather than assumed. Only the codes the Sandbox seed plants are.
export function configFor(configs: AxleConfiguration[], code: string): string {
  const found = configs.filter((c) => c.code === code);
  expect(found, `no ${code} axle configuration in Sandbox Fleet`).not.toHaveLength(0);
  return found[0].id;
}

export async function createUnit(
  page: Page,
  fleetNumber: string,
  unitKind: string,
  configurationId: string,
): Promise<string> {
  const created = (await apiPost(page, "/api/vehicles", {
    fleetNumber,
    unitKind,
    configurationId,
  })) as { id: string };
  return created.id;
}

export interface MinimalInspectionOptions {
  vehicleId: string;
  positionId: string;
  treadCount: number;
}

// The body observations.spec.ts and tasks.spec.ts both post: one reading,
// treads filled from the tenant's configured count. A field a caller needs
// beyond that (task_id, combination_id, a fixed started_at) comes through as
// an override rather than a parameter of its own.
export function submitMinimalInspection(
  page: Page,
  headers: Record<string, string>,
  options: MinimalInspectionOptions & Record<string, unknown>,
): Promise<APIResponse> {
  const { vehicleId, positionId, treadCount, ...overrides } = options;
  return page.request.post("/api/inspections", {
    headers,
    data: {
      client_uuid: randomUUID(),
      vehicle_id: vehicleId,
      started_at: new Date(Date.now() - 120_000).toISOString(),
      submitted_at: new Date().toISOString(),
      duration_seconds: 120,
      readings: [
        {
          vehicle_id: vehicleId,
          position_id: positionId,
          tyre_id: null,
          pressure_kpa: 800,
          treads: Array.from({ length: treadCount }, (_, i) => 8 + i * 0.2),
        },
      ],
      ...overrides,
    },
  });
}
