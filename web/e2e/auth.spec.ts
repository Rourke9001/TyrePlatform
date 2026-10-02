import { expect, test, type Page } from "@playwright/test";

import { captureAll, capturePosition, done, startInspection, submit } from "./captureSteps";
import { ageToken, lapseSession, stubIdentityProvider, type IdpStub } from "./idp";
import {
  SANDBOX_DRIVER,
  apiGet,
  apiPost,
  configFor,
  createUnit,
  type AxleConfiguration,
} from "./sandbox";

// Sign-in against a stubbed identity provider (spec section 7). Submit cases
// write Sandbox Fleet (TYRE-80), one unit each, so FR-INS-038's window is
// never shared. Serial for load, because parallel position walks starve the
// other projects' 5s expect budgets.
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
  expect(stub.withDevHeaders, "a bearer call also carried dev actor headers").toEqual([]);
});

// Through page.request as the Sandbox controller, which page.route never
// sees, so setup is outside the bearer checks.
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

// A submit case walks every position of a unit, which can pass Playwright's
// 30s default on a loaded CI box. Each step keeps its own 5s expect budget, so
// a regression fails at its step.
const WALK_TIMEOUT_MS = 120_000;

// The outbox band. Only its lines carry the status role, so the actions are
// reached through the lines' parent.
function outboxBand(page: Page) {
  return page.getByRole("status").filter({ hasText: "Sign in to send 1 inspection" }).locator("..");
}

// A submit a stubbed 401 holds, stamped for whoever is signed in.
async function holdOneSubmit(page: Page, vehicleId: string) {
  await startInspection(page, vehicleId);
  await captureAll(page);
  // Older than the fresh-token window, so the refusal below lapses the
  // session and holds the entry; a fresh token refused would latch the store
  // as "the API refuses every valid token" (src/api/token.ts, refused()).
  await ageToken(page);
  stub.refuseSubmits = true;
  await submit(page);
  await expect(done(page)).toContainText("Sign in to send it.");
}

// FR-OFF-012's 30-minute ceiling, so the app-open flush, the online flush and
// the heartbeat all pass the held entry by inside the test. Only the flush
// after sign-in ignores the backoff (spec section 4, After sign-in). Returns
// the rows moved.
async function backOffHeld(page: Page): Promise<number> {
  return page.evaluate(async (ms) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("tyre-capture");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(new Error("tyre-capture did not open"));
    });
    try {
      return await new Promise<number>((resolve, reject) => {
        let moved = 0;
        const tx = db.transaction("outbox", "readwrite");
        const cursor = tx.objectStore("outbox").openCursor();
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (row === null) return;
          row.update({ ...(row.value as object), nextAttemptAt: Date.now() + ms });
          moved += 1;
          row.continue();
        };
        tx.oncomplete = () => resolve(moved);
        tx.onerror = () => reject(new Error("the outbox write failed"));
      });
    } finally {
      db.close();
    }
  }, 30 * 60_000);
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
  expect(stub.apiBearers).toContain("/api/me Bearer e2e-at-e2e-oid-a");
});

test("a sign-in started from a capture returns there with the draft restored", async ({ page }) => {
  const vehicleId = await unitForDriver(page, "R");
  await page.goto("/");
  await signIn(page);
  await startInspection(page, vehicleId);
  // One position's readings, so the draft's content survives, not only its row.
  await page.locator("[data-position-id]").first().click();
  await capturePosition(page);
  const progress = page.getByRole("heading", { name: /^1 of \d+ done/ });
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
  test.setTimeout(WALK_TIMEOUT_MS);
  const vehicleId = await unitForDriver(page, "H");
  await page.goto("/");
  await signIn(page);
  await holdOneSubmit(page, vehicleId);
  await expect(page.getByText("Sign in to send 1 inspection")).toBeVisible();
  // Before the stub stops refusing, so no other flush can send it first.
  expect(await backOffHeld(page)).toBe(1);

  stub.refuseSubmits = false;
  await lapseSession(page);
  // The sign-in is a full navigation, so "hidden" would hold trivially until
  // the app is back; the server accepting the send is the signal, and with
  // the backoff above only the flush after sign-in can send it.
  const accepted = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && new URL(r.url()).pathname === "/api/inspections" && r.ok(),
  );
  await outboxBand(page).getByRole("button", { name: "Sign in" }).click();
  await accepted;
});

test("a sign-in by another driver while an entry is held is undone, and the entry stays", async ({
  page,
}) => {
  test.setTimeout(WALK_TIMEOUT_MS);
  const vehicleId = await unitForDriver(page, "U");
  await page.goto("/");
  await signIn(page);
  await holdOneSubmit(page, vehicleId);

  await lapseSession(page);
  stub.refuseSubmits = false;
  stub.subject = "e2e-oid-b";
  await page.goto("/");
  // One waiting count beside the sign-in screen, the outbox band's (U107).
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByText(/1 inspection waiting to send/)).toBeVisible();
  await expect(page.getByText(/waiting to send/)).toHaveCount(1);
  await page.getByRole("button", { name: "Email me a sign-in code" }).click();

  await expect.poll(() => stub.endSessionUrls.length).toBe(1);
  await expect(
    page.getByRole("alert").filter({ hasText: /captured by another driver/ }),
  ).toBeVisible();
  await expect(page.getByText(/1 inspection waiting to send/)).toBeVisible();
  // main.tsx renders only after the compare, so the new subject's token never
  // reached the API at all, not /api/me and not the flush.
  expect(stub.apiBearers.filter((b) => b.includes("e2e-oid-b"))).toEqual([]);
  expect(stub.submitBearers.filter((b) => b.includes("e2e-oid-b"))).toEqual([]);
});

test("sign-out is refused while an entry is held, and goes ahead once the outbox is empty", async ({
  page,
}) => {
  test.setTimeout(WALK_TIMEOUT_MS);
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
  expect(stub.endSessionUrls).toHaveLength(0);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect.poll(() => stub.endSessionUrls.length).toBe(1);
  expect(stub.endSessionUrls[0].searchParams.get("id_token_hint")).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  expect(await page.evaluate(() => window.localStorage.getItem("tyre.auth.mirror"))).toBeNull();
});

// NFR-USE-004: the keypad and tiles sit at 56 to 64px for gloves, and the
// sign-in controls are tapped the same way.
test("the sign-in controls are at least 56px tall at a 390px viewport", async ({ page }) => {
  test.setTimeout(WALK_TIMEOUT_MS);
  await page.setViewportSize({ width: 390, height: 844 });
  const vehicleId = await unitForDriver(page, "V");
  await page.goto("/");
  const signInButton = page.getByRole("button", { name: "Email me a sign-in code" });
  await expect(signInButton).toBeVisible();
  expect((await signInButton.boundingBox())?.height).toBeGreaterThanOrEqual(56);

  await signIn(page);
  await holdOneSubmit(page, vehicleId);
  await expect(page.getByText("Sign in to send 1 inspection")).toBeVisible();
  const outboxSignIn = outboxBand(page).getByRole("button", { name: "Sign in" });
  await expect(outboxSignIn).toBeVisible();
  expect((await outboxSignIn.boundingBox())?.height).toBeGreaterThanOrEqual(56);
});

// The band keeps to one row of the phone with its sign-in action and that
// action's failure line both showing, so nothing scrolls sideways.
test("the outbox band does not overflow a 360px viewport with the sign-in failure line showing", async ({
  page,
}) => {
  test.setTimeout(WALK_TIMEOUT_MS);
  await page.setViewportSize({ width: 360, height: 780 });
  const vehicleId = await unitForDriver(page, "N");
  await page.goto("/");
  await signIn(page);
  await holdOneSubmit(page, vehicleId);

  // No signal for the identity provider. This page has not yet loaded its
  // metadata, so the start fails before it can leave the page.
  await page.route("https://idp.test/.well-known/openid-configuration", (route) => route.abort());
  const band = outboxBand(page);
  await band.getByRole("button", { name: "Sign in" }).click();
  await expect(
    band
      .getByRole("alert")
      .filter({ hasText: "Could not start sign-in. Find signal and try again." }),
  ).toBeVisible();
  expect(await band.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
