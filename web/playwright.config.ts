import { defineConfig, devices } from "@playwright/test";

// E2E runs against the DEV server on purpose: identity comes from the dev
// actor headers (src/api/devTenant.ts), which exist only when
// import.meta.env.DEV is true — there is no real identity provider yet
// (FR-AUT-001), so a production build has no way to be anyone. The API must
// already be listening on :8080 with APP_DEV_TENANT_HEADER=1 over a seeded
// database; `make e2e` checks that before it launches anything.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  // A stray test.only would silently shrink the suite to one test in CI —
  // the same silent-gate failure mode TYRE-49 exists to prevent.
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
  },
  projects: [
    // capture.spec.ts submits, and FR-INS-038's duplicate window is tenant
    // state in one shared database: the same vehicle captured on a second
    // project is refused by the first project's submit. It runs on one project
    // only, gated here rather than skipped inside the file — a skip still has
    // Playwright launch a browser and build a context per project to decide it.
    { name: "chromium", use: { ...devices["Desktop Chrome"] }, testIgnore: /capture\.spec/ },
    // The capture app is judged at phone dimensions or not at all: thumb reach,
    // 44px targets and sunlight legibility are the design, not the styling.
    // Pixel 7 and iPhone 14 bracket the sizes a driver actually carries.
    //
    // admin.spec.ts creates a unit and a user per run. Rows, not just reads —
    // so it runs on one project, like capture.spec.ts and for a related
    // reason: a second project repeats the writes rather than the assertions.
    { name: "android", use: { ...devices["Pixel 7"] }, testIgnore: /admin\.spec/ },
    // iPhone 14 is WebKit, which `make e2e` and CI install alongside chromium.
    // It earns its place beyond the viewport: iOS is where FR-OFF-020's
    // storage eviction is a real risk, so the outbox has to be exercised on it.
    { name: "ios", use: { ...devices["iPhone 14"] }, testIgnore: /capture\.spec|admin\.spec/ },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
