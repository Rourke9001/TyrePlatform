import { expect, test, type Page } from "@playwright/test";

import { capturePosition, done, startInspection, submit } from "./captureSteps";
import { ageToken, lapseSession, stubIdentityProvider, type IdpStub } from "./idp";
import {
  SANDBOX_DRIVER,
  apiGet,
  apiPost,
  configFor,
  createUnit,
  type AxleConfiguration,
} from "./sandbox";

// Sign-in against a stubbed identity provider (spec section 7). Serial: the
// submit cases write Sandbox Fleet (TYRE-80), each on a unit of its own, so
// FR-INS-038's window is never shared. Setup goes through page.request as the
// Sandbox controller, which page.route never sees.
test.describe.configure({ mode: "serial" });

const RUN = Date.now().toString().slice(-6);
// ActorBadge's whole line, so the DevBar's "Sandbox Driver" option cannot
// match too.
const SIGNED_IN_AS = "Sandbox Driver · DRIVER";
let stub: IdpStub;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("tyre.dev.auth", "bearer"));
  stub = await stubIdentityProvider(page);
});

test.afterEach(() => {
  expect(stub.withoutBearer, "an /api call went out with no bearer").toEqual([]);
});

async function unitForDriver(page: Page, label: string): Promise<string> {
  const configs = (await apiGet(page, "/api/axle-configurations")) as AxleConfiguration[];
  const id = await createUnit(page, `AU${label}-${RUN}`, "HORSE", configFor(configs, "HORSE_6X4"));
  await apiPost(page, `/api/vehicles/${id}/drivers`, { userId: SANDBOX_DRIVER });
  return id;
}

async function signIn(page: Page) {
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();
  await expect(page.getByText(SIGNED_IN_AS)).toBeVisible();
}

// A submit a stubbed 401 holds, stamped for whoever is signed in.
async function holdOneSubmit(page: Page, vehicleId: string) {
  await startInspection(page, vehicleId);
  // A position closes itself and opens the next, so one tap starts the walk
  // and the sheet is only dismissed once every position has its readings.
  await expect(page.locator("[data-position-id]").first()).toBeVisible();
  const total = await page.locator("[data-position-id]").count();
  await page.locator("[data-position-id]").first().click();
  for (let i = 0; i < total; i++) await capturePosition(page);
  await ageToken(page);
  stub.refuseSubmits = true;
  await submit(page);
  await expect(done(page)).toContainText("Sign in to send it.");
}

test("signed out, the app shows the sign-in screen and asks for a code with PKCE", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();
  await expect.poll(() => stub.authorizeUrls.length).toBeGreaterThan(0);

  const url = stub.authorizeUrls[0];
  expect(url.searchParams.get("client_id")).toBe("e2e-pwa");
  expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5173/");
  expect(url.searchParams.get("scope")).toBe(
    "openid profile offline_access api://e2e-api/access_as_user",
  );
  expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  expect(url.searchParams.get("code_challenge")).toBeTruthy();
});

test("the callback completes and /api/me carries the bearer", async ({ page }) => {
  await page.goto("/");
  await signIn(page);
  expect(new URL(page.url()).searchParams.has("code")).toBe(false);
  expect(stub.apiBearers).toContain("Bearer e2e-at-e2e-oid-a");
});

test("a sign-in started from a capture returns there with the draft restored", async ({ page }) => {
  const vehicleId = await unitForDriver(page, "R");
  await page.goto("/");
  await signIn(page);
  await startInspection(page, vehicleId);
  const progress = page.getByRole("heading", { name: /of \d+ done/ });
  await expect(progress).toBeVisible();

  await lapseSession(page);
  await page.reload();
  await signIn(page);

  await expect(page).toHaveURL(new RegExp(`/capture/${vehicleId}$`));
  await expect(progress).toBeVisible();
});

test("an error callback says the sign-in did not finish", async ({ page }) => {
  stub.failNextAuthorize = true;
  await page.goto("/");
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();
  await expect(page.getByText("Sign-in did not finish. Try again.")).toBeVisible();
});

test("a submit refused with 401 is held, asks for a sign-in, and sends after it", async ({
  page,
}) => {
  const vehicleId = await unitForDriver(page, "H");
  await page.goto("/");
  await signIn(page);
  await holdOneSubmit(page, vehicleId);
  await expect(page.getByText("Sign in to send 1 inspection")).toBeVisible();

  stub.refuseSubmits = false;
  await lapseSession(page);
  const sent = stub.submitBearers.length;
  await page.locator(".cap-outbox").getByRole("button", { name: "Sign in" }).click();

  // The sign-in is a full navigation, so "hidden" holds trivially until the
  // app is back; the send itself is the signal.
  await expect.poll(() => stub.submitBearers.length).toBeGreaterThan(sent);
  await expect(page.getByText(/waiting to send/)).toBeHidden();
});

test("a sign-in by another driver while an entry is held is undone, and the entry stays", async ({
  page,
}) => {
  const vehicleId = await unitForDriver(page, "U");
  await page.goto("/");
  await signIn(page);
  await holdOneSubmit(page, vehicleId);

  await lapseSession(page);
  stub.refuseSubmits = false;
  stub.subject = "e2e-oid-b";
  await page.goto("/");
  await expect(page.getByText("1 inspection is waiting to send on this phone.")).toBeVisible();
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();

  await expect.poll(() => stub.endSessionUrls.length).toBe(1);
  await expect(
    page.getByRole("alert").filter({ hasText: /captured by another driver/ }),
  ).toBeVisible();
  await expect(page.getByText(/1 inspection waiting to send/)).toBeVisible();
  // main.tsx renders only after the compare: the new subject's token never
  // reached the API at all, not /api/me and not the flush.
  expect(stub.apiBearers.filter((b) => b.includes("e2e-oid-b"))).toEqual([]);
  expect(stub.submitBearers.filter((b) => b.includes("e2e-oid-b"))).toEqual([]);
});

test("sign-out is refused while an entry is held, and goes ahead once the outbox is empty", async ({
  page,
}) => {
  const vehicleId = await unitForDriver(page, "S");
  await page.goto("/");
  await signIn(page);
  await holdOneSubmit(page, vehicleId);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("status").filter({ hasText: /still on this phone/ })).toBeVisible();
  expect(stub.endSessionUrls).toHaveLength(0);

  stub.refuseSubmits = false;
  await page.getByRole("button", { name: /sync now/i }).click();
  await expect(page.getByText(/waiting to send/)).toBeHidden();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => stub.endSessionUrls.length).toBe(1);
  expect(stub.endSessionUrls[0].searchParams.get("id_token_hint")).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("tyre.auth.mirror"))).toBeNull();
});
